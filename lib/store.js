// Where the arrivals state lives.
//
//  - On Vercel: Upstash Redis, reached over its REST API with plain fetch. The connection
//    details come from the env vars the Vercel Marketplace integration injects.
//  - Locally (npm run dev): a JSON file under .local-data/, so the app runs with no account.
//
// Both backends expose the same three calls:
//    rev()        -> number, bumped on every change (cheap; used by the polling clients)
//    read()       -> { rev, event, roster, status, users, secret }
//    write(ops)   -> applies the ops, bumps rev, returns the fresh state in the same round trip
//
// Each person's status is its own hash field, so two volunteers checking in different
// people at the same moment can never overwrite each other.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY = {
  rev: 'arrivals:rev',
  event: 'arrivals:event',
  roster: 'arrivals:roster',
  status: 'arrivals:status',
  users: 'arrivals:users', // logins: { id: { salt, hash, v, createdAt } } - never sent to a browser
  secret: 'arrivals:secret', // signs the login cookies - never sent to a browser
};

export class StoreError extends Error {
  constructor(message, status = 502, code = 'storage') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

/** Find the Redis REST credentials, whatever prefix the store was connected with. */
export function findRedisEnv(env = process.env) {
  const known = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ];
  for (const [urlKey, tokenKey] of known) {
    if (env[urlKey] && env[tokenKey]) return { url: env[urlKey], token: env[tokenKey] };
  }
  // A custom prefix chosen in the Vercel dashboard, e.g. ARRIVALS_KV_REST_API_URL.
  for (const key of Object.keys(env)) {
    const match = key.match(/^(.*)(KV_REST_API_URL|REDIS_REST_URL)$/);
    if (!match) continue;
    const tokenKey = match[1] + (match[2] === 'KV_REST_API_URL' ? 'KV_REST_API_TOKEN' : 'REDIS_REST_TOKEN');
    if (env[key] && env[tokenKey]) return { url: env[key], token: env[tokenKey] };
  }
  return null;
}

function safeParse(text) {
  if (typeof text !== 'string') return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** HGETALL comes back as a flat [field, value, ...] array over REST; accept an object too. */
function hashToObject(hash) {
  const out = {};
  if (Array.isArray(hash)) {
    for (let i = 0; i + 1 < hash.length; i += 2) out[hash[i]] = safeParse(hash[i + 1]);
  } else if (hash && typeof hash === 'object') {
    for (const [field, value] of Object.entries(hash)) out[field] = safeParse(value);
  }
  return out;
}

const READ_COMMANDS = [
  ['GET', KEY.rev],
  ['GET', KEY.event],
  ['GET', KEY.roster],
  ['HGETALL', KEY.status],
  ['GET', KEY.users],
  ['GET', KEY.secret],
];

function fromReadResults([rev, event, roster, status, users, secret]) {
  const parsedUsers = safeParse(users);
  return {
    rev: Number(rev) || 0,
    event: safeParse(event),
    roster: safeParse(roster),
    status: hashToObject(status),
    users: parsedUsers && typeof parsedUsers === 'object' ? parsedUsers : {},
    secret: typeof secret === 'string' && secret ? secret : null,
  };
}

function redisBackend({ url, token }) {
  const base = url.replace(/\/+$/, '');

  async function send(endpoint, commands) {
    let res;
    try {
      res = await fetch(base + endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
      });
    } catch (err) {
      throw new StoreError(`Could not reach the database (${err.message}).`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data)) {
      const detail = data && data.error ? data.error : `HTTP ${res.status}`;
      throw new StoreError(`The database rejected the request: ${detail}`);
    }
    return data.map((item) => {
      if (item && item.error) throw new StoreError(`The database rejected the request: ${item.error}`);
      return item ? item.result : null;
    });
  }

  function toCommands(op) {
    switch (op.op) {
      case 'setStatus':
        return [['HSET', KEY.status, op.id, JSON.stringify(op.value)]];
      case 'clearStatus':
        if (!op.ids) return [['DEL', KEY.status]];
        return op.ids.length ? [['HDEL', KEY.status, ...op.ids]] : [];
      case 'setEvent':
        return [['SET', KEY.event, JSON.stringify(op.value)]];
      case 'setRoster':
        return [['SET', KEY.roster, JSON.stringify(op.value)]];
      case 'setUsers':
        return [['SET', KEY.users, JSON.stringify(op.value)]];
      case 'setSecret':
        return [['SET', KEY.secret, op.value]];
      default:
        throw new Error(`Unknown store op: ${op.op}`);
    }
  }

  return {
    kind: 'redis',
    async rev() {
      const [rev] = await send('/pipeline', [['GET', KEY.rev]]);
      return Number(rev) || 0;
    },
    async read() {
      return fromReadResults(await send('/pipeline', READ_COMMANDS));
    },
    async write(ops) {
      const writes = ops.flatMap(toCommands);
      writes.push(['INCR', KEY.rev]);
      // One atomic transaction: apply the change, then read everything back.
      const results = await send('/multi-exec', [...writes, ...READ_COMMANDS]);
      return fromReadResults(results.slice(writes.length));
    },
  };
}

function fileBackend(file) {
  let cache = null;
  let queue = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Could not read ${file} (${err.message}); starting fresh.`);
      cache = {};
    }
    cache = {
      rev: cache.rev || 0,
      event: cache.event || null,
      roster: cache.roster || null,
      status: cache.status || {},
      users: cache.users || {},
      secret: cache.secret || null,
    };
    return cache;
  }

  async function save() {
    await mkdir(path.dirname(file), { recursive: true });
    const text = JSON.stringify(cache, null, 2);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text);
    try {
      await rename(tmp, file);
    } catch {
      await writeFile(file, text); // a sync client (OneDrive) may briefly hold the file open
    }
  }

  return {
    kind: 'file',
    async rev() {
      return (await load()).rev;
    },
    async read() {
      return structuredClone(await load());
    },
    write(ops) {
      const run = async () => {
        const state = await load();
        for (const op of ops) {
          if (op.op === 'setStatus') state.status[op.id] = op.value;
          else if (op.op === 'clearStatus') {
            if (!op.ids) state.status = {};
            else for (const id of op.ids) delete state.status[id];
          } else if (op.op === 'setEvent') state.event = op.value;
          else if (op.op === 'setRoster') state.roster = op.value;
          else if (op.op === 'setUsers') state.users = op.value;
          else if (op.op === 'setSecret') state.secret = op.value;
          else throw new Error(`Unknown store op: ${op.op}`);
        }
        state.rev += 1;
        await save();
        return structuredClone(state);
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
  };
}

let store = null;

export function getStore() {
  if (store) return store;
  const redis = findRedisEnv();
  if (redis) {
    store = redisBackend(redis);
  } else if (process.env.VERCEL) {
    // Vercel functions have no durable disk, so there is nothing safe to fall back to.
    // Say what this deployment can actually see (names only, never values) so the fix is obvious.
    const seen = Object.keys(process.env).filter((key) => /KV_|REDIS|UPSTASH/i.test(key)).sort();
    const where = process.env.VERCEL_ENV ? ` (${process.env.VERCEL_ENV})` : '';
    const detail = seen.length
      ? `This deployment${where} has ${seen.join(', ')} but not KV_REST_API_URL with KV_REST_API_TOKEN. In Vercel, open Storage, open the database, and connect it to this project for Production.`
      : `This deployment${where} has no database settings. If the Upstash Redis database is already connected in Vercel, open Deployments and choose Redeploy: only deployments made after connecting can use it. Also check the database is connected for Production.`;
    throw new StoreError(`Storage is not connected. ${detail}`, 503, 'no_storage');
  } else {
    store = fileBackend(process.env.ARRIVALS_DATA_FILE || path.resolve('.local-data', 'state.json'));
  }
  return store;
}
