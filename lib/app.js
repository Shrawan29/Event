// The whole API: one Web-standard handler (Request -> Response).
//
//   GET  /api            -> full state (public: the projector board reads it without logging in)
//   GET  /api?rev=N      -> 204 if nothing changed since revision N, otherwise the full state
//   POST /api  { action, ... } -> applies the action and returns the fresh state
//
// Changing anything needs a login. The first visitor creates the first login ("setup"); after
// that, logins are added from the check-in desk. A login is an HttpOnly cookie signed with a
// secret kept in the database, so the browser's scripts never see it.
//
// The same handler runs as the Vercel Function (api/index.js) and under the local dev server.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import seed from './seed.js';
import { getStore } from './store.js';

const STATUSES = new Set(['expected', 'arrived', 'delayed', 'cancelled']);
const MAX_BODY_CHARS = 64_000;
const MAX_NAME = 60;
const MAX_PEOPLE = 1000;
const MAX_USERS = 20;
const MIN_PASSWORD = 8;
const USER_ID = /^[a-z0-9][a-z0-9._-]{2,19}$/;
const SESSION_COOKIE = 'arrivals_session';
const SESSION_DAYS = 30;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

// ---------- state ----------

const pad2 = (n) => String(n).padStart(2, '0');

// How the projector board lays itself out. 0 means "automatic".
const BOARD_DEFAULTS = { perScreen: 0, cols: 0, secs: 12, order: 'list' };

function defaults() {
  const counters = {};
  const roster = seed.people.map((person) => {
    counters[person.group] = (counters[person.group] || 0) + 1;
    const code = person.group + pad2(counters[person.group]);
    return { id: code, code, group: person.group, name: person.name };
  });
  return {
    event: { name: seed.eventName, reportingAt: '', autoDelay: true, groups: seed.groups, board: { ...BOARD_DEFAULTS } },
    roster,
  };
}

/**
 * Merge what is stored with the defaults into the shape the screens consume.
 * `user` is the logged-in ID or null. Password hashes and the signing secret never leave here.
 */
function view(raw, user) {
  const base = defaults();
  const event = { ...base.event, ...(raw.event || {}) };
  event.board = { ...BOARD_DEFAULTS, ...(event.board || {}) };
  const roster = Array.isArray(raw.roster) ? raw.roster : base.roster;

  // Groups are the built-in ones plus any group that people on the list still belong to.
  // A name edited in Settings is kept; a group nobody belongs to any more is dropped.
  const savedGroups = Array.isArray(event.groups) ? event.groups : [];
  const groupIds = new Set([...base.event.groups.map((group) => group.id), ...roster.map((person) => person.group)]);
  event.groups = [...groupIds].map((id) => {
    const saved = savedGroups.find((group) => group && group.id === id);
    const builtIn = base.event.groups.find((group) => group.id === id);
    return { id, label: (saved && saved.label) || (builtIn && builtIn.label) || id };
  });

  const members = roster.map((person) => {
    const saved = raw.status[person.id] || {};
    const member = {
      ...person,
      status: STATUSES.has(saved.status) ? saved.status : 'expected',
      arrivedAt: saved.arrivedAt || null,
      updatedAt: saved.updatedAt || null,
    };
    if (user) member.by = saved.by || null; // who marked them: for the desk and the export only
    return member;
  });

  const state = {
    rev: raw.rev,
    now: Date.now(),
    auth: { user: user || null, setup: Object.keys(raw.users).length === 0 },
    event,
    members,
  };
  if (user) state.users = Object.keys(raw.users).sort().map((id) => ({ id, createdAt: raw.users[id].createdAt || null }));
  return state;
}

// ---------- logins ----------

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

let decoy = null; // checked when the ID does not exist, so a wrong ID takes as long as a wrong password

function passwordMatches(user, password) {
  if (!user) decoy = decoy || hashPassword(randomBytes(12).toString('hex'));
  const record = user || decoy;
  const expected = Buffer.from(record.hash, 'hex');
  const actual = scryptSync(password, record.salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual) && Boolean(user);
}

function makeToken(secret, id, version) {
  const payload = Buffer.from(JSON.stringify({ u: id, v: version, exp: Date.now() + SESSION_DAYS * 86_400_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/** The logged-in ID for this request, or null. */
function readSession(request, raw) {
  if (!raw.secret) return null;
  const match = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, mac] = match[1].split('.');
  if (!payload || !mac) return null;
  const expected = createHmac('sha256', raw.secret).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const user = typeof data.u === 'string' && Object.hasOwn(raw.users, data.u) ? raw.users[data.u] : null;
    // A changed password bumps the version, which signs that login out everywhere else.
    if (!user || user.v !== data.v || !(data.exp > Date.now())) return null;
    return data.u;
  } catch {
    return null;
  }
}

function sessionCookie(request, token) {
  const https = new URL(request.url, 'http://localhost').protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const life = token ? SESSION_DAYS * 86_400 : 0;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${life}${https ? '; Secure' : ''}`;
}

function cleanUserId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USER_ID.test(id)) {
    throw new HttpError(400, 'An ID is 3 to 20 characters: small letters, numbers, dot, dash or underscore (for example desk1).');
  }
  return id;
}

function cleanPassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD) {
    throw new HttpError(400, `A password needs at least ${MIN_PASSWORD} characters.`);
  }
  if (value.length > 200) throw new HttpError(400, 'That password is too long.');
  return value;
}

const newUser = (password) => ({ ...hashPassword(password), v: 1, createdAt: new Date().toISOString() });

async function login(request, store, raw, body) {
  const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
  const user = Object.hasOwn(raw.users, id) ? raw.users[id] : null;
  if (!passwordMatches(user, typeof body.password === 'string' ? body.password : '')) {
    throw new HttpError(401, 'That ID or password is not correct.', 'login');
  }
  let current = raw;
  if (!current.secret) current = await store.write([{ op: 'setSecret', value: randomBytes(32).toString('hex') }]);
  return json(200, view(current, id), { 'Set-Cookie': sessionCookie(request, makeToken(current.secret, id, user.v)) });
}

/** Only while no login exists: whoever opens the site first creates the first one. */
async function setup(request, store, raw, body) {
  if (Object.keys(raw.users).length) throw new HttpError(409, 'Logins already exist. Log in instead.', 'setup_done');
  const id = cleanUserId(body.id);
  const password = cleanPassword(body.password);
  const secret = raw.secret || randomBytes(32).toString('hex');
  const fresh = await store.write([
    { op: 'setSecret', value: secret },
    { op: 'setUsers', value: { [id]: newUser(password) } },
  ]);
  return json(200, view(fresh, id), { 'Set-Cookie': sessionCookie(request, makeToken(secret, id, 1)) });
}

// ---------- validation ----------

function cleanName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'A name is required.');
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) throw new HttpError(400, 'A name is required.');
  if (name.length > MAX_NAME) throw new HttpError(400, `Names can be at most ${MAX_NAME} characters ("${name.slice(0, 20)}...").`);
  return name;
}

function findMember(state, id) {
  const member = state.members.find((m) => m.id === id);
  if (!member) throw new HttpError(404, 'That person is no longer on the list. Refresh and try again.');
  return member;
}

const rosterOf = (state) => state.members.map(({ id, code, group, name }) => ({ id, code, group, name }));

function cleanBoard(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid board settings.');
  const whole = (value, min, max, label) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
    }
    return number;
  };
  const next = { ...BOARD_DEFAULTS, ...current };
  if (input.perScreen !== undefined) {
    next.perScreen = Number(input.perScreen) === 0 ? 0 : whole(input.perScreen, 4, 60, 'People per screen');
  }
  if (input.cols !== undefined) next.cols = whole(input.cols, 0, 3, 'Columns');
  if (input.secs !== undefined) next.secs = whole(input.secs, 5, 120, 'Seconds per screen');
  if (input.order !== undefined) {
    if (input.order !== 'list' && input.order !== 'az') throw new HttpError(400, 'Unknown name order.');
    next.order = input.order;
  }
  return next;
}

// ---------- actions (all need a login) ----------
// Each gets (state, body, { user, raw }) and returns the store operations to apply.

const actions = {
  ping: () => [],

  status(state, body, { user }) {
    const member = findMember(state, body.id);
    if (!STATUSES.has(body.status)) throw new HttpError(400, 'Unknown status.');
    if (body.status === 'expected') return [{ op: 'clearStatus', ids: [member.id] }];
    const now = new Date().toISOString();
    // Two volunteers tapping "Arrived" for the same person must not move the arrival time.
    const arrivedAt = body.status === 'arrived' ? (member.status === 'arrived' && member.arrivedAt) || now : null;
    return [{ op: 'setStatus', id: member.id, value: { status: body.status, arrivedAt, updatedAt: now, by: user } }];
  },

  add(state, body) {
    const group = state.event.groups.find((g) => g.id === body.group) || (state.event.groups.length === 1 ? state.event.groups[0] : null);
    if (!group) throw new HttpError(400, 'Choose a group for the new people.');
    const names = (Array.isArray(body.names) ? body.names : [body.name])
      .filter((n) => typeof n === 'string' && n.trim())
      .map(cleanName);
    if (!names.length) throw new HttpError(400, 'Enter at least one name.');
    const roster = rosterOf(state);
    if (roster.length + names.length > MAX_PEOPLE) throw new HttpError(400, `The list is limited to ${MAX_PEOPLE} people.`);
    let next = roster
      .filter((p) => p.group === group.id)
      .reduce((max, p) => Math.max(max, parseInt(p.code.slice(group.id.length), 10) || 0), 0);
    for (const name of names) {
      next += 1;
      const code = group.id + pad2(next);
      roster.push({ id: code, code, group: group.id, name });
    }
    return [{ op: 'setRoster', value: roster }];
  },

  rename(state, body) {
    const member = findMember(state, body.id);
    const name = cleanName(body.name);
    return [{ op: 'setRoster', value: rosterOf(state).map((p) => (p.id === member.id ? { ...p, name } : p)) }];
  },

  remove(state, body) {
    const member = findMember(state, body.id);
    return [
      { op: 'setRoster', value: rosterOf(state).filter((p) => p.id !== member.id) },
      { op: 'clearStatus', ids: [member.id] },
    ];
  },

  event(state, body) {
    const next = { ...state.event };
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'The event needs a name.');
      next.name = body.name.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    if (body.reportingAt !== undefined) {
      if (body.reportingAt === '' || body.reportingAt === null) next.reportingAt = '';
      else {
        const time = typeof body.reportingAt === 'string' ? Date.parse(body.reportingAt) : NaN;
        if (Number.isNaN(time)) throw new HttpError(400, 'The reporting time is not a valid date and time.');
        next.reportingAt = new Date(time).toISOString();
      }
    }
    if (body.autoDelay !== undefined) next.autoDelay = Boolean(body.autoDelay);
    if (body.groups !== undefined) {
      if (!Array.isArray(body.groups)) throw new HttpError(400, 'Invalid group labels.');
      next.groups = state.event.groups.map((group) => {
        const sent = body.groups.find((g) => g && g.id === group.id);
        const label = sent && typeof sent.label === 'string' ? sent.label.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
        return { id: group.id, label: label || group.label };
      });
    }
    if (body.board !== undefined) next.board = cleanBoard(body.board, state.event.board);
    return [{ op: 'setEvent', value: next }];
  },

  reset: () => [{ op: 'clearStatus', ids: null }],

  userAdd(state, body, { raw }) {
    const id = cleanUserId(body.id);
    if (Object.hasOwn(raw.users, id)) throw new HttpError(409, `The ID "${id}" is already in use.`);
    if (Object.keys(raw.users).length >= MAX_USERS) throw new HttpError(400, `There can be at most ${MAX_USERS} logins.`);
    return [{ op: 'setUsers', value: { ...raw.users, [id]: newUser(cleanPassword(body.password)) } }];
  },

  userPassword(state, body, { raw }) {
    const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    if (!Object.hasOwn(raw.users, id)) throw new HttpError(404, 'That login no longer exists.');
    const existing = raw.users[id];
    const changed = { ...existing, ...hashPassword(cleanPassword(body.password)), v: (existing.v || 1) + 1 };
    return [{ op: 'setUsers', value: { ...raw.users, [id]: changed } }];
  },

  userRemove(state, body, { raw, user }) {
    const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    if (!Object.hasOwn(raw.users, id)) throw new HttpError(404, 'That login no longer exists.');
    if (id === user) throw new HttpError(400, 'You cannot remove the login you are using right now.');
    const rest = { ...raw.users };
    delete rest[id];
    return [{ op: 'setUsers', value: rest }];
  },
};

// ---------- handler ----------

async function readBody(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  // Requiring JSON also blocks cross-site form posts: other origins cannot send this type without CORS.
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new HttpError(413, 'That request is too large.');
  try {
    const body = JSON.parse(text || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

async function getState(request, url) {
  const store = getStore();
  const known = url.searchParams.get('rev');
  if (known !== null && String(await store.rev()) === known) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  const raw = await store.read();
  return json(200, view(raw, readSession(request, raw)));
}

async function postAction(request) {
  const body = await readBody(request);
  const store = getStore();
  const raw = await store.read();

  if (body.action === 'login') return login(request, store, raw, body);
  if (body.action === 'setup') return setup(request, store, raw, body);
  if (body.action === 'logout') return json(200, view(raw, null), { 'Set-Cookie': sessionCookie(request, '') });

  const action = Object.hasOwn(actions, body.action) ? actions[body.action] : null;
  if (!action) throw new HttpError(400, 'Unknown action.');
  const user = readSession(request, raw);
  if (!user) throw new HttpError(401, 'Log in to make changes.', 'auth');

  const ops = action(view(raw, user), body, { user, raw });
  if (!ops.length) return json(200, view(raw, user));
  const fresh = await store.write(ops);
  const headers = {};
  // Changing your own password would sign you out with everyone else; stay logged in here.
  if (body.action === 'userPassword' && Object.hasOwn(fresh.users, user)) {
    headers['Set-Cookie'] = sessionCookie(request, makeToken(fresh.secret, user, fresh.users[user].v));
  }
  return json(200, view(fresh, user), headers);
}

export async function handle(request) {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET') return await getState(request, url);
    if (request.method === 'POST') return await postAction(request);
    return json(405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
  } catch (err) {
    const status = err.expose && err.status ? err.status : 500;
    if (status >= 500) console.error(err);
    return json(status, {
      error: err.expose ? err.message : 'Something went wrong on the server. Please try again.',
      code: err.code,
    });
  }
}
