/* Arrivals board: a split-flap display that pages through the guest list and announces arrivals.
   How many people share a screen, the columns, the paging speed and the name order come from the
   shared board settings (desk Settings, or press D on this screen). */
(() => {
  'use strict';

  const A = window.Arrivals;
  const $ = (id) => document.getElementById(id);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const STATUS_TEXT = { expected: 'EXPECTED', arrived: 'ARRIVED', delayed: 'DELAYED', cancelled: 'CANCELLED' };
  const TIME_LEN = 5;
  const STATUS_LEN = 9;
  const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const FRESH_MS = 2 * 60 * 1000;
  // Tile geometry, in units of one tile width (gaps) or one tile height (rows).
  const GROUP_GAP = 1;
  const COLUMN_GAP = 3;
  const ROW_PITCH = 1.22;
  const HEAD_HEIGHT = 1.1;
  const MIN_RATIO = 1.4; // tile height / width: tiles stretch between these to use the whole screen
  const MAX_RATIO = 1.6;
  const MIN_READABLE = 0.026; // in automatic mode, tiles never get shorter than this share of the screen height

  const boardEl = $('board');
  let state = null;
  let layout = null; // the tile grid currently in the DOM
  let pages = [];
  let pageIndex = 0;
  let paused = false;
  let rotateTimer = 0;
  let pageAnimation = null;

  // ---------- split-flap engine ----------
  // Every tile that needs to change runs through a few random characters before settling,
  // all driven by one requestAnimationFrame loop.

  const flipping = new Set();
  let ticking = false;
  const SETTLE = [{ transform: 'rotateX(-80deg)' }, { transform: 'rotateX(0deg)' }];

  function makeCell() {
    const el = document.createElement('span');
    el.className = 'fc';
    const glyph = document.createElement('b');
    el.append(glyph);
    return { el, glyph, target: ' ', steps: 0, at: 0 };
  }

  const show = (cell, ch) => {
    cell.glyph.textContent = ch === ' ' ? '' : ch;
  };

  function flipTo(cell, ch, delay) {
    if (cell.target === ch) return;
    cell.target = ch;
    if (reducedMotion) return show(cell, ch);
    cell.steps = 2 + Math.floor(Math.random() * 4);
    cell.at = performance.now() + delay;
    flipping.add(cell);
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(tick);
    }
  }

  function tick(time) {
    for (const cell of flipping) {
      if (time < cell.at) continue;
      if (cell.steps > 0) {
        cell.steps -= 1;
        show(cell, GLYPHS[Math.floor(Math.random() * GLYPHS.length)]);
        cell.at = time + 50;
      } else {
        show(cell, cell.target);
        flipping.delete(cell);
        cell.glyph.animate(SETTLE, { duration: 140, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    }
    if (flipping.size) requestAnimationFrame(tick);
    else ticking = false;
  }

  function write(cells, text, delay) {
    for (let i = 0; i < cells.length; i++) flipTo(cells[i], text[i] || ' ', delay + i * 14);
  }

  // ---------- pixel-exact tiles ----------

  /**
   * Set the tile measurements on a container, snapped to whole screen pixels. Without this the
   * hinge line lands on half pixels and looks thicker or blurrier in some rows than in others.
   */
  function setTileVars(el, cw, ch) {
    const dpr = window.devicePixelRatio || 1;
    const whole = (value, min = 1) => Math.max(min, Math.floor(value * dpr)) / dpr;
    const even = (value) => Math.max(2, Math.floor((value * dpr) / 2) * 2) / dpr; // the middle falls on a pixel edge
    const pitch = whole(cw, 3);
    const gap = whole(cw * 0.08);
    const height = even(ch);
    const vars = {
      '--cw': pitch,
      '--tg': gap,
      '--tw': pitch - gap,
      '--ch': height,
      '--rh': height + even(ch * (ROW_PITCH - 1)),
      '--hh': whole(ch * HEAD_HEIGHT),
      '--sl': whole(ch * 0.03),
    };
    for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, `${value.toFixed(3)}px`);
  }

  /**
   * Fonts do not place capitals in the middle of their line box, so letters would sit above the
   * hinge. Measure the font actually in use and nudge every letter so its middle is on the hinge.
   */
  function centreGlyphs() {
    const tile = makeCell();
    tile.el.style.visibility = 'hidden';
    boardEl.append(tile.el);
    const style = getComputedStyle(tile.glyph);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${style.fontWeight} 100px ${style.fontFamily}`;
    const metrics = ctx.measureText('H');
    tile.el.remove();
    if (!metrics.fontBoundingBoxAscent) return;
    const shift = (metrics.actualBoundingBoxAscent - metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / 200;
    document.body.style.setProperty('--glyph-shift', `${shift.toFixed(3)}em`);
  }
  centreGlyphs();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(centreGlyphs);

  // ---------- planning: who goes on which screen, and how big the tiles can be ----------

  const boardName = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

  /** The largest tile that fits `cols` x `rows` into the board area, using the full width and height. */
  function tileSize(width, height, cols, rows, units) {
    let cw = width / (cols * units + (cols - 1) * COLUMN_GAP);
    let ch = height / (rows * ROW_PITCH + HEAD_HEIGHT);
    if (ch > cw * MAX_RATIO) ch = cw * MAX_RATIO; // the width is the limit
    else if (ch < cw * MIN_RATIO) cw = ch / MIN_RATIO; // the height is the limit
    return { cw, ch };
  }

  /** The column count that shows `count` people with the tallest letters. */
  function arrange(count, fixedCols, width, height, units) {
    let best = null;
    for (const cols of fixedCols ? [fixedCols] : [1, 2, 3]) {
      const rows = Math.ceil(count / cols);
      const size = tileSize(width, height, cols, rows, units);
      if (!best || size.ch > best.ch * 1.03) best = { cols, rows, ...size };
    }
    return best;
  }

  function plan() {
    const settings = state.event.board;
    const width = boardEl.clientWidth;
    const height = boardEl.clientHeight;
    const nameLen = Math.min(26, Math.max(14, ...state.members.map((m) => boardName(m.name).length)));
    const codeLen = Math.min(5, Math.max(3, ...state.members.map((m) => m.code.length)));
    const units = codeLen + nameLen + TIME_LEN + STATUS_LEN + GROUP_GAP * 3;

    const groups = [];
    for (const group of state.event.groups) {
      let people = state.members.filter((m) => m.group === group.id);
      if (!people.length) continue;
      if (settings.order === 'az') people = [...people].sort((a, b) => a.name.localeCompare(b.name));
      groups.push({ label: group.label, people });
    }

    let capacity = settings.perScreen;
    if (!capacity) {
      // Automatic: as few screens as possible while the letters stay readable from the back of the room.
      const largest = Math.max(1, ...groups.map((group) => group.people.length));
      const readable = innerHeight * MIN_READABLE;
      for (let parts = 1; parts <= largest; parts++) {
        capacity = Math.ceil(largest / parts);
        if (arrange(capacity, settings.cols, width, height, units).ch >= readable) break;
      }
    }

    // Each group starts on its own screen; a group that needs several screens is split evenly.
    const next = [];
    for (const group of groups) {
      const parts = Math.ceil(group.people.length / capacity);
      const size = Math.ceil(group.people.length / parts);
      for (let part = 0; part < parts; part++) {
        next.push({ label: group.label, part: part + 1, parts, items: group.people.slice(part * size, (part + 1) * size) });
      }
    }
    if (!next.length) next.push({ label: 'No guests yet', part: 1, parts: 1, items: [] });
    const biggest = Math.max(1, ...next.map((page) => page.items.length));

    pages = next;
    if (pageIndex >= pages.length) pageIndex = 0;
    const fit = arrange(biggest, settings.cols, width, height, units);
    return { cols: fit.cols, rows: fit.rows, cw: Math.max(4, fit.cw), ch: Math.max(6, fit.ch), nameLen, codeLen, biggest };
  }

  // ---------- layout ----------

  function makeGroup(length, className) {
    const el = document.createElement('span');
    el.className = `g ${className}`;
    const cells = [];
    for (let i = 0; i < length; i++) {
      const cell = makeCell();
      el.append(cell.el);
      cells.push(cell);
    }
    return { el, cells };
  }

  function makeHead(fields) {
    const head = document.createElement('div');
    head.className = 'colhead';
    for (const [label, length] of fields) {
      const span = document.createElement('span');
      span.textContent = label;
      span.style.width = `calc(var(--cw) * ${length} - var(--tg))`;
      head.append(span);
    }
    return head;
  }

  /** Build the empty tile grid. Rebuilt only when the geometry actually changes. */
  function ensureLayout(want) {
    const key = [want.cols, want.rows, want.cw.toFixed(1), want.ch.toFixed(1), want.nameLen, want.codeLen].join('|');
    if (layout && layout.key === key) {
      layout.biggest = want.biggest;
      return;
    }

    flipping.clear();
    setTileVars(boardEl, want.cw, want.ch);
    boardEl.replaceChildren();
    const slots = [];
    for (let c = 0; c < want.cols; c++) {
      const col = document.createElement('div');
      col.className = 'col';
      col.append(makeHead([['No.', want.codeLen], ['Name', want.nameLen], ['Time', TIME_LEN], ['Status', STATUS_LEN]]));
      const colSlots = [];
      for (let r = 0; r < want.rows; r++) {
        const el = document.createElement('div');
        el.className = 'row';
        el.dataset.st = 'none';
        const slot = {
          el,
          code: makeGroup(want.codeLen, 'g-code'),
          name: makeGroup(want.nameLen, 'g-name'),
          time: makeGroup(TIME_LEN, 'g-time'),
          status: makeGroup(STATUS_LEN, 'g-status'),
        };
        el.append(slot.code.el, slot.name.el, slot.time.el, slot.status.el);
        col.append(el);
        colSlots.push(slot);
      }
      boardEl.append(col);
      slots.push(colSlots);
    }
    layout = { key, cols: want.cols, rows: want.rows, slots, biggest: want.biggest };
  }

  // ---------- painting ----------

  function paintRow(slot, m, row) {
    const eff = m ? A.effectiveStatus(m, state.event) : 'none';
    slot.el.dataset.st = eff;
    const fresh = Boolean(m && m.status === 'arrived' && m.arrivedAt && A.now() - Date.parse(m.arrivedAt) < FRESH_MS);
    slot.el.classList.toggle('fresh', fresh);
    const delay = row * 16;
    write(slot.code.cells, m ? m.code : '', delay);
    write(slot.name.cells, m ? boardName(m.name) : '', delay + 30);
    write(slot.time.cells, m && m.status === 'arrived' && m.arrivedAt ? A.hhmm(m.arrivedAt) : '', delay + 60);
    write(slot.status.cells, m ? STATUS_TEXT[eff] : '', delay + 90);
  }

  function renderPage() {
    const page = pages[pageIndex];
    const perCol = Math.min(layout.rows, Math.ceil(page.items.length / layout.cols));
    for (let c = 0; c < layout.cols; c++) {
      for (let r = 0; r < layout.rows; r++) {
        paintRow(layout.slots[c][r], r < perCol ? page.items[c * perCol + r] : null, r);
      }
    }
    $('pageLabel').textContent = page.parts > 1 ? `${page.label} ${page.part}/${page.parts}` : page.label;
    $('dots').replaceChildren(
      ...(pages.length > 1 ? pages : []).map((_, i) => {
        const dot = document.createElement('i');
        if (i === pageIndex) dot.className = 'on';
        return dot;
      }),
    );
  }

  function renderChrome() {
    const counts = A.tally(state);
    $('eventName').textContent = state.event.name;
    document.title = `Arrivals: ${state.event.name}`;
    $('tArrived').textContent = counts.arrived;
    $('tTotal').textContent = `/ ${counts.total}`;
    $('meterBar').style.transform = `scaleX(${counts.total ? counts.arrived / counts.total : 0})`;
    $('tDelayed').textContent = counts.delayed;
    $('tCancelled').textContent = counts.cancelled;
    $('tExpected').textContent = counts.expected;

    const bits = [];
    if (state.event.reportingAt) bits.push(`Reporting time ${A.hhmm(state.event.reportingAt)}`);
    if (paused) bits.push('Paused');
    $('subRight').textContent = bits.join('  ·  ');

    const last = state.members
      .filter((m) => m.status === 'arrived' && m.arrivedAt)
      .sort((a, b) => Date.parse(b.arrivedAt) - Date.parse(a.arrivedAt))[0];
    const latest = $('latest');
    latest.replaceChildren();
    if (last) {
      const label = document.createElement('span');
      label.textContent = 'Last arrived';
      const name = document.createElement('b');
      name.textContent = `${boardName(last.name)}  ${A.hhmm(last.arrivedAt)}`;
      latest.append(label, name);
    }
  }

  function goToPage(index) {
    pageIndex = (index + pages.length) % pages.length;
    renderPage();
    restartRotation();
  }

  /** Restart the countdown to the next screen, with the thin progress line under the header. */
  function restartRotation() {
    clearTimeout(rotateTimer);
    if (pageAnimation) pageAnimation.cancel();
    pageAnimation = null;
    if (!state || paused || pages.length < 2) return;
    const duration = state.event.board.secs * 1000;
    if (!reducedMotion) {
      pageAnimation = $('pageBar').animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration, easing: 'linear' });
    }
    rotateTimer = setTimeout(() => goToPage(pageIndex + 1), duration);
  }

  function refresh() {
    if (!state) return;
    ensureLayout(plan());
    renderChrome();
    renderPage();
    syncPanel();
  }

  // ---------- "just landed" announcements ----------

  const announceEl = $('announce');
  const queue = [];
  let announcing = false;
  let known = null; // id -> last seen status

  function nextAnnouncement() {
    let m = null;
    while (queue.length && !m) {
      const candidate = state.members.find((x) => x.id === queue[0]);
      queue.shift();
      if (candidate && candidate.status === 'arrived') m = candidate; // skip anyone undone meanwhile
    }
    if (!m) {
      announcing = false;
      return;
    }
    announcing = true;

    // Turn to that person's screen so the audience sees their row flip behind the banner.
    const page = pages.findIndex((p) => p.items.some((x) => x.id === m.id));
    if (page >= 0 && page !== pageIndex) goToPage(page);
    else restartRotation();

    const name = boardName(m.name);
    const holder = $('annName');
    const cw = Math.min((innerWidth * 0.9) / Math.max(name.length, 10), innerHeight * 0.12);
    setTileVars(holder, cw, cw * 1.5);
    const cells = Array.from(name, () => makeCell());
    holder.replaceChildren(...cells.map((cell) => cell.el));
    $('annMeta').textContent = `${m.code}  ·  ${m.arrivedAt ? A.hhmm(m.arrivedAt) : ''}`;
    announceEl.classList.add('show');
    cells.forEach((cell, i) => flipTo(cell, name[i], 250 + i * 45));
    chime();

    setTimeout(() => {
      announceEl.classList.remove('show');
      setTimeout(nextAnnouncement, 500);
    }, queue.length ? 3400 : 5200);
  }

  function noteArrivals(next) {
    if (known) {
      for (const m of next.members) {
        if (m.status === 'arrived' && known.get(m.id) !== 'arrived') queue.push(m.id);
      }
      if (queue.length > 6) queue.splice(0, queue.length - 6); // after a long outage, show only the latest few
    }
    known = new Map(next.members.map((m) => [m.id, m.status]));
    if (queue.length && !announcing) nextAnnouncement();
  }

  // ---------- sound (off until someone turns it on; browsers require a click first) ----------

  let audio = null;

  function chime() {
    if (!audio) return;
    const start = audio.currentTime + 0.05;
    [[659.25, 0], [523.25, 0.45]].forEach(([frequency, offset]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, start + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 1.5);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 1.6);
    });
  }

  function toggleSound() {
    const button = $('btnSound');
    if (audio) {
      audio.close();
      audio = null;
    } else {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audio = new Ctx();
      chime();
    }
    button.setAttribute('aria-pressed', String(Boolean(audio)));
    button.lastElementChild.textContent = audio ? 'Sound on' : 'Sound off';
  }

  // ---------- display settings panel ----------

  const panel = $('panel');
  const panelFields = { perScreen: $('pPer'), cols: $('pCols'), secs: $('pSecs'), order: $('pOrder') };
  let saving = false;

  function panelStatus(text, kind) {
    const el = $('panelStatus');
    el.textContent = text || '';
    el.dataset.kind = kind || '';
  }

  /** Show the saved settings in the panel, and what they mean for the audience. */
  function syncPanel() {
    if (!state || panel.hidden) return;
    if (!saving) {
      for (const [key, select] of Object.entries(panelFields)) A.fillChoice(select, key, state.event.board[key]);
    }
    // The audience may look, but only a logged-in volunteer may change the board.
    const loggedIn = Boolean(state.auth.user);
    for (const select of Object.values(panelFields)) select.disabled = !loggedIn;
    $('pLogin').hidden = loggedIn;
    const total = pages.length * state.event.board.secs;
    const cycle = total >= 60 ? `${Math.floor(total / 60)} min ${total % 60 ? `${total % 60} s` : ''}`.trim() : `${total} s`;
    $('panelSummary').textContent =
      pages.length > 1
        ? `Now: ${pages.length} screens with up to ${layout.biggest} people each (each group is split evenly). Everyone is shown once every ${cycle}.`
        : `Now: everyone fits on one screen (${layout.biggest} people).`;
  }

  async function saveBoard() {
    const board = {
      perScreen: Number(panelFields.perScreen.value),
      cols: Number(panelFields.cols.value),
      secs: Number(panelFields.secs.value),
      order: panelFields.order.value,
    };
    saving = true;
    panelStatus('Saving…');
    try {
      await A.post('event', { board });
      panelStatus('Saved. This screen has updated.', 'ok');
      restartRotation();
    } catch (err) {
      // A login that lapsed while the panel was open: show the log-in link instead of the choices.
      if (err.code === 'auth') state.auth.user = null;
      panelStatus(`Not saved. ${err.message}`, 'error');
    }
    saving = false;
    syncPanel();
  }

  for (const select of Object.values(panelFields)) select.addEventListener('change', saveBoard);

  function togglePanel(open) {
    const willOpen = open ?? panel.hidden;
    panel.hidden = !willOpen;
    if (willOpen) {
      saving = false;
      panelStatus('');
      syncPanel();
      (state && state.auth.user ? panelFields.perScreen : $('pLoginLink')).focus();
    } else if (document.activeElement) {
      document.activeElement.blur();
    }
    wake();
  }

  $('btnPanel').addEventListener('click', () => togglePanel());
  $('panelClose').addEventListener('click', () => togglePanel(false));

  // ---------- controls ----------

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  $('btnSound').addEventListener('click', toggleSound);
  $('btnFull').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    $('btnFull').lastElementChild.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) return togglePanel(false);
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return; // typing or choosing in the panel
    const key = event.key.toLowerCase();
    if (key === 'f') toggleFullscreen();
    else if (key === 's') toggleSound();
    else if (key === 'd') togglePanel();
    else if (key === 'arrowright' && state) goToPage(pageIndex + 1);
    else if (key === 'arrowleft' && state) goToPage(pageIndex - 1);
    else if (key === ' ' && state && event.target.tagName !== 'BUTTON') {
      event.preventDefault();
      paused = !paused;
      renderChrome();
      restartRotation();
    }
  });

  // Hide the pointer and the buttons when nobody is touching the mouse.
  let idleTimer = 0;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!panel.hidden) return;
      // Drop focus from a clicked button so the toolbar does not linger in front of the audience.
      if ($('controls').contains(document.activeElement)) document.activeElement.blur();
      document.body.classList.add('idle');
    }, 4000);
  }
  ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((type) => document.addEventListener(type, wake, { passive: true }));
  wake();

  // Keep the laptop from dimming or sleeping while the board is up (where the browser allows it).
  async function keepAwake() {
    try {
      if (navigator.wakeLock && !document.hidden) await navigator.wakeLock.request('screen');
    } catch {
      /* not available here; set the laptop's sleep timer to "never" for the event instead */
    }
  }
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();

  // ---------- clock ----------

  function tickClock() {
    const date = new Date(A.now());
    $('clock').textContent = `${A.pad(date.getHours())}:${A.pad(date.getMinutes())}`;
    $('date').textContent = date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
  }
  tickClock();
  setInterval(tickClock, 1000);

  // "Delayed after the reporting time" and the just-arrived highlight depend on the clock.
  setInterval(refresh, 15000);

  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      refresh();
      restartRotation();
    }, 150);
  });

  // ---------- live connection ----------

  function notice(title, text) {
    $('notice').hidden = !title;
    $('noticeTitle').textContent = title || '';
    $('noticeText').textContent = text || '';
  }

  A.connect(
    (next) => {
      const before = state && JSON.stringify(state.event.board);
      state = next;
      notice(null);
      const pageCount = pages.length;
      refresh();
      // Restart the countdown when the board first loads or its paging changed.
      if (before !== JSON.stringify(next.event.board) || pageCount !== pages.length) restartRotation();
      noteArrivals(next);
    },
    (ok, err) => {
      $('offline').hidden = ok;
      if (ok) return;
      wake();
      if (err && err.code === 'no_storage') notice('Setup needed', err.message);
      else if (!state) notice('Connecting', 'Trying to reach the server. This screen will start by itself.');
    },
  );
})();
