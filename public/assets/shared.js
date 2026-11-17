/* Shared client for the check-in desk and the arrivals board: API calls, live updates, time helpers. */
window.Arrivals = (() => {
  'use strict';

  let clockOffset = 0; // server clock minus this device's clock, so every screen agrees on "now"
  let live = null;

  const now = () => Date.now() + clockOffset;
  const pad = (n) => String(n).padStart(2, '0');

  /** The login page, set to come back to the page we are on. */
  const loginUrl = () => `/login?next=${encodeURIComponent(location.pathname)}`;

  /** What a person shows as: anyone still "expected" after the reporting time counts as delayed. */
  function effectiveStatus(member, event) {
    if (member.status !== 'expected') return member.status;
    if (event && event.autoDelay && event.reportingAt) {
      const due = Date.parse(event.reportingAt);
      if (!Number.isNaN(due) && now() > due) return 'delayed';
    }
    return 'expected';
  }

  function tally(state) {
    const counts = { total: state.members.length, expected: 0, arrived: 0, delayed: 0, cancelled: 0 };
    for (const member of state.members) counts[effectiveStatus(member, state.event)] += 1;
    return counts;
  }

  function hhmm(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function toError(res) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `The server returned an error (${res.status}).`);
    err.code = data.code;
    err.status = res.status;
    return err;
  }

  async function post(action, payload) {
    let res;
    try {
      res = await fetch('/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, action }), // the login cookie is sent by the browser itself
      });
    } catch {
      throw Object.assign(new Error('No connection. Check the internet and try again.'), { code: 'offline' });
    }
    if (!res.ok) throw await toError(res);
    const state = await res.json();
    if (live) live.accept(state);
    return state;
  }

  /**
   * Keep a screen in sync. Vercel functions cannot hold a connection open, so this polls a tiny
   * "has anything changed since revision N?" endpoint: every 2s while the event is active,
   * slowing down after long quiet spells so a forgotten tab does not burn through free quotas.
   */
  function connect(onState, onStatus) {
    let rev = null;
    let timer = 0;
    let busy = false;
    let lastChange = Date.now();
    let staleHits = 0;

    function accept(state) {
      clockOffset = state.now - Date.now();
      // A slow poll can land after the reply to our own change; ignore it unless it repeats.
      if (rev !== null && state.rev < rev && ++staleHits < 2) return;
      staleHits = 0;
      if (state.rev !== rev) lastChange = Date.now();
      rev = state.rev;
      onState(state);
    }

    function nextDelay(failed) {
      if (failed) return 3000;
      if (document.hidden) return 20000;
      const idle = Date.now() - lastChange;
      if (idle < 10 * 60 * 1000) return 2000;
      return idle < 60 * 60 * 1000 ? 4000 : 10000;
    }

    async function poll() {
      if (busy) return;
      busy = true;
      clearTimeout(timer);
      let failed = false;
      try {
        const res = await fetch(rev === null ? '/api' : `/api?rev=${rev}`, { cache: 'no-store' });
        if (res.status === 200) accept(await res.json());
        else if (res.status !== 204) throw await toError(res);
        onStatus(true);
      } catch (err) {
        failed = true;
        onStatus(false, err);
      }
      busy = false;
      timer = setTimeout(poll, nextDelay(failed));
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poll();
    });
    window.addEventListener('online', poll);

    live = { accept, refresh: poll };
    poll();
    return live;
  }

  // Choices offered for the projector board, shared by the desk's Settings and the board's own panel.
  const BOARD_CHOICES = {
    perScreen: {
      values: [0, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 50, 60],
      label: (v) => (v === 0 ? 'Auto (fill the screen)' : `Up to ${v} people`),
    },
    cols: {
      values: [0, 1, 2, 3],
      label: (v) => (v === 0 ? 'Auto (largest text)' : v === 1 ? '1 column' : `${v} columns`),
    },
    secs: {
      values: [8, 10, 12, 15, 20, 30, 45, 60],
      label: (v) => `${v} seconds`,
    },
    order: {
      values: ['list', 'az'],
      label: (v) => (v === 'az' ? 'A to Z' : 'List order (by number)'),
    },
  };

  /** Fill a <select> with one of the BOARD_CHOICES and select the current value. */
  function fillChoice(select, key, current) {
    const choice = BOARD_CHOICES[key];
    const values = choice.values.includes(current) ? choice.values : [...choice.values, current];
    select.replaceChildren(
      ...values.map((value) => {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = choice.label(value);
        return option;
      }),
    );
    select.value = String(current);
  }

  return { now, pad, hhmm, loginUrl, effectiveStatus, tally, post, connect, fillChoice };
})();
