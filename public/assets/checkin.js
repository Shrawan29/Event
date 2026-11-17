/* Check-in desk: search the list, mark people Arrived / Delayed / Cancelled, manage the event. */
(() => {
  'use strict';

  const A = window.Arrivals;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LABEL = { expected: 'Expected', arrived: 'Arrived', delayed: 'Delayed', cancelled: 'Cancelled' };

  let state = null;
  const filter = { q: '', group: 'all', status: 'all' };
  const busy = new Set(); // ids with a save in flight
  const rows = new Map(); // id -> <li>
  const list = $('list');

  // ---------- small DOM helpers ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function actionButton(className, act, label, iconName, disabled) {
    const button = el('button', `btn ${className}`);
    button.type = 'button';
    button.dataset.act = act;
    button.disabled = disabled;
    if (iconName) button.append(icon(iconName));
    button.append(el('span', null, label));
    return button;
  }

  const groupLabel = (id) => (state.event.groups.find((g) => g.id === id) || { label: id }).label;
  const member = (id) => state.members.find((m) => m.id === id);

  // ---------- rendering ----------

  function paintRow(li, m) {
    const isBusy = busy.has(m.id);
    const signature = [m.code, m.name, groupLabel(m.group), state.event.groups.length, m.status, m.arrivedAt, isBusy].join('|');
    if (li.dataset.sig === signature) return;

    const focused = li.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    li.dataset.sig = signature;
    li.dataset.st = m.status;

    const who = el('div', 'who');
    who.append(el('span', 'code', m.code));
    const nm = el('div', 'nm');
    nm.append(el('span', 'name', m.name));
    const sub = el('div', 'sub');
    if (state.event.groups.length > 1) sub.append(el('span', null, groupLabel(m.group))); // one list needs no label
    if (m.status !== 'expected') {
      const pill = el('span', `pill pill-${m.status}`);
      pill.append(icon(m.status === 'arrived' ? 'check' : m.status === 'delayed' ? 'clock' : 'x'));
      let text = LABEL[m.status];
      if (m.status === 'arrived' && m.arrivedAt) text += ` ${A.hhmm(m.arrivedAt)}`;
      pill.append(el('span', null, text));
      sub.append(pill);
    }
    if (sub.childElementCount) nm.append(sub);
    who.append(nm);

    const acts = el('div', 'acts');
    if (m.status !== 'arrived') acts.append(actionButton('btn-ok', 'arrived', 'Arrived', 'check', isBusy));
    if (m.status === 'expected') acts.append(actionButton('btn-warn', 'delayed', 'Delayed', 'clock', isBusy));
    if (m.status === 'expected' || m.status === 'delayed') acts.append(actionButton('btn-danger-ghost', 'cancelled', 'Cancelled', 'x', isBusy));
    if (m.status !== 'expected') acts.append(actionButton('btn-ghost', 'expected', 'Undo', 'undo', isBusy));
    const more = actionButton('btn-icon', 'edit', '', 'more', false);
    more.setAttribute('aria-label', `Edit ${m.name}`);
    more.lastChild.remove();
    acts.append(more);

    li.replaceChildren(who, acts);
    if (focused) (li.querySelector(`[data-act="${focused}"]`) || li.querySelector('button')).focus();
  }

  function matches(m) {
    if (filter.group !== 'all' && m.group !== filter.group) return false;
    if (filter.status !== 'all' && m.status !== filter.status) return false;
    if (!filter.q) return true;
    const haystack = `${m.name} ${m.code}`.toLowerCase();
    return filter.q.split(/\s+/).every((term) => haystack.includes(term));
  }

  function renderChips() {
    const chips = $('groupChips');
    // With a single list there is nothing to choose between.
    chips.hidden = state.event.groups.length < 2;
    if (chips.hidden) filter.group = 'all';
    const options =[{ id: 'all', label: 'Everyone', count: state.members.length }].concat(
      state.event.groups.map((g) => ({ id: g.id, label: g.label, count: state.members.filter((m) => m.group === g.id).length })),
    );
    const signature = JSON.stringify(options) + filter.group;
    if (chips.dataset.sig === signature) return;
    chips.dataset.sig = signature;
    chips.replaceChildren(
      ...options.map((option) => {
        const chip = el('button', 'chip', `${option.label} ${option.count}`);
        chip.type = 'button';
        chip.dataset.group = option.id;
        chip.setAttribute('aria-pressed', String(filter.group === option.id));
        return chip;
      }),
    );
  }

  function renderSummary() {
    const counts = A.tally(state);
    $('nArrived').textContent = counts.arrived;
    $('nExpected').textContent = counts.expected;
    $('nDelayed').textContent = counts.delayed;
    $('nCancelled').textContent = counts.cancelled;
    for (const stat of document.querySelectorAll('.stat')) {
      stat.setAttribute('aria-pressed', String(filter.status === stat.dataset.status));
    }
    $('progressBar').style.transform = `scaleX(${counts.total ? counts.arrived / counts.total : 0})`;
    $('progress').setAttribute('aria-label', `${counts.arrived} of ${counts.total} arrived`);

    $('who').textContent = `Logged in as ${state.auth.user}`;
    const dueAt = A.dueTime(state.event); // moves on by 5 minutes each time the clock reaches it
    const due = dueAt === null ? null : new Date(dueAt);
    $('reporting').textContent = due
      ? `Reporting time ${A.hhmm(due)}, ${due.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`
      : 'No reporting time set';
  }

  function render() {
    if (!state) return;
    document.title = `Check-in desk: ${state.event.name}`;
    $('eventName').textContent = state.event.name;
    renderSummary();
    renderChips();

    const visible = [];
    state.members.forEach((m, index) => {
      let li = rows.get(m.id);
      if (!li) {
        li = el('li', 'person');
        li.dataset.id = m.id;
        rows.set(m.id, li);
      }
      if (list.children[index] !== li) list.insertBefore(li, list.children[index] || null);
      paintRow(li, m);
      const show = matches(m);
      li.hidden = !show;
      if (show) visible.push(m);
    });
    for (const [id, li] of rows) {
      if (!member(id)) {
        li.remove();
        rows.delete(id);
      }
    }

    const empty = $('empty');
    empty.hidden = visible.length > 0;
    if (!visible.length) {
      const raw = $('search').value.trim();
      $('emptyText').textContent = raw
        ? `No one matches "${raw}". Check the spelling, or add them as a new person.`
        : 'No one is in this view right now.';
      $('btnAddFromEmpty').hidden = !raw;
    }

    const hint = $('enterHint');
    const only = filter.q && visible.length === 1 && visible[0].status !== 'arrived' ? visible[0] : null;
    hint.hidden = !only;
    if (only) hint.textContent = `Press Enter to mark ${only.name} arrived.`;
    hint.dataset.id = only ? only.id : '';
  }

  // ---------- toast ----------

  let toastTimer = 0;
  let toastUndo = null;

  function toast(text, options = {}) {
    clearTimeout(toastTimer);
    const box = $('toast');
    $('toastText').textContent = text;
    box.dataset.kind = options.error ? 'error' : 'info';
    toastUndo = options.undo || null;
    $('toastUndo').hidden = !toastUndo;
    box.hidden = true; // restart the entrance animation
    void box.offsetWidth;
    box.hidden = false;
    toastTimer = setTimeout(() => {
      box.hidden = true;
    }, options.error || toastUndo ? 6000 : 3500);
  }

  $('toastUndo').addEventListener('click', () => {
    const undo = toastUndo;
    $('toast').hidden = true;
    if (undo) undo();
  });

  // ---------- talking to the server ----------

  /** Run an action. Errors come back as { error }; a lapsed login sends the volunteer to log in again. */
  async function attempt(action, payload) {
    try {
      return { state: await A.post(action, payload) };
    } catch (err) {
      if (err.code === 'auth') location.assign(A.loginUrl());
      return { error: err.message };
    }
  }

  async function setStatus(id, status, quiet) {
    const m = member(id);
    if (!m || busy.has(id)) return;
    const before = m.status;
    if (before === status) return;
    busy.add(id);
    render();
    const result = await attempt('status', { id, status });
    busy.delete(id);
    render();
    if (result.error) {
      toast(`${m.name} was not saved. ${result.error}`, { error: true });
    } else if (!quiet) {
      const text = status === 'expected' ? `${m.name} set back to expected` : `${m.name} marked ${LABEL[status].toLowerCase()}`;
      toast(text, { undo: () => setStatus(id, before, true) });
    }
  }

  // ---------- dialogs ----------

  function showError(id, message) {
    const box = $(id);
    box.textContent = message || '';
    box.hidden = !message;
  }

  for (const closer of document.querySelectorAll('[data-close]')) {
    closer.addEventListener('click', () => closer.closest('dialog').close('cancel'));
  }

  function setSubmitting(form, on) {
    for (const button of form.querySelectorAll('button')) button.disabled = on;
  }

  function confirmAsk({ title, text, ok }) {
    const dialog = $('dlgConfirm');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = ok;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
  }

  // Logins
  function renderUsers() {
    if (!state || !state.users) return;
    $('userList').replaceChildren(
      ...state.users.map((user) => {
        const me = user.id === state.auth.user;
        const li = el('li', 'user');
        li.append(el('span', 'user-id', user.id));
        if (me) li.append(el('span', 'user-me', 'you'));
        const tools = el('span', 'user-tools');
        const change = el('button', 'btn btn-ghost', 'New password');
        change.type = 'button';
        change.dataset.user = user.id;
        change.dataset.task = 'password';
        change.setAttribute('aria-label', `New password for ${user.id}`);
        tools.append(change);
        if (!me) {
          const remove = el('button', 'btn btn-danger-ghost', 'Remove');
          remove.type = 'button';
          remove.dataset.user = user.id;
          remove.dataset.task = 'remove';
          remove.setAttribute('aria-label', `Remove the login ${user.id}`);
          tools.append(remove);
        }
        li.append(tools);
        return li;
      }),
    );
  }

  $('btnUsers').addEventListener('click', () => {
    renderUsers();
    $('newUserId').value = '';
    $('newUserPass').value = '';
    showError('usersError', '');
    $('dlgUsers').showModal();
  });

  $('formUserAdd').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('newUserId').value.trim().toLowerCase();
    const password = $('newUserPass').value;
    if (!id) {
      showError('usersError', 'Type an ID for the new login.');
      return $('newUserId').focus();
    }
    if (password.length < 8) {
      showError('usersError', 'The password needs at least 8 characters.');
      return $('newUserPass').focus();
    }
    setSubmitting(event.target, true);
    const result = await attempt('userAdd', { id, password });
    setSubmitting(event.target, false);
    if (result.error) return showError('usersError', result.error);
    showError('usersError', '');
    $('newUserId').value = '';
    $('newUserPass').value = '';
    renderUsers();
    toast(`Login ${id} added`);
  });

  let passwordFor = null;

  $('userList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-task]');
    if (!button) return;
    const id = button.dataset.user;
    if (button.dataset.task === 'password') {
      passwordFor = id;
      $('passwordTitle').textContent = `New password for ${id}`;
      $('passwordInput').value = '';
      showError('passwordError', '');
      $('dlgPassword').showModal();
      return;
    }
    const yes = await confirmAsk({
      title: `Remove the login ${id}?`,
      text: 'Anyone using this ID is logged out straight away. Check-ins they made are kept.',
      ok: 'Remove login',
    });
    if (!yes) return;
    const result = await attempt('userRemove', { id });
    if (result.error) return showError('usersError', result.error);
    renderUsers();
    toast(`Login ${id} removed`);
  });

  $('formPassword').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('passwordInput').value;
    if (password.length < 8) {
      showError('passwordError', 'The password needs at least 8 characters.');
      return $('passwordInput').focus();
    }
    setSubmitting(event.target, true);
    const result = await attempt('userPassword', { id: passwordFor, password });
    setSubmitting(event.target, false);
    if (result.error) return showError('passwordError', result.error);
    $('dlgPassword').close();
    toast(`Password changed for ${passwordFor}`);
  });

  $('btnLogout').addEventListener('click', async () => {
    try {
      await A.post('logout');
    } catch {
      /* offline: the login page will sort it out */
    }
    location.assign('/login');
  });

  // Settings
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${A.pad(d.getMonth() + 1)}-${A.pad(d.getDate())}T${A.pad(d.getHours())}:${A.pad(d.getMinutes())}`;
  };

  $('btnSettings').addEventListener('click', () => {
    if (!state) return;
    $('setName').value = state.event.name;
    $('setReporting').value = toLocalInput(state.event.reportingAt);
    const single = state.event.groups.length < 2;
    $('setGroupsLegend').textContent = single ? 'List name' : 'Group names';
    $('setGroups').replaceChildren(
      ...state.event.groups.map((g) => {
        const label = el('label', 'field');
        label.append(el('span', 'field-help', single ? 'Shown on the board above the names' : `Group ${g.id}`));
        const input = el('input');
        input.type = 'text';
        input.maxLength = 24;
        input.value = g.label;
        input.dataset.group = g.id;
        input.setAttribute('aria-label', `Name for group ${g.id}`);
        label.append(input);
        return label;
      }),
    );
    A.fillChoice($('setPer'), 'perScreen', state.event.board.perScreen);
    A.fillChoice($('setCols'), 'cols', state.event.board.cols);
    A.fillChoice($('setSecs'), 'secs', state.event.board.secs);
    A.fillChoice($('setOrder'), 'order', state.event.board.order);
    $('meId').textContent = state.auth.user;
    showError('settingsError', '');
    $('dlgSettings').showModal();
  });

  $('formSettings').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('setName').value.trim();
    if (!name) {
      showError('settingsError', 'Give the event a name.');
      return $('setName').focus();
    }
    const local = $('setReporting').value;
    setSubmitting(event.target, true);
    const result = await attempt('event', {
      name,
      reportingAt: local ? new Date(local).toISOString() : '',
      groups: [...$('setGroups').querySelectorAll('input')].map((input) => ({ id: input.dataset.group, label: input.value })),
      board: {
        perScreen: Number($('setPer').value),
        cols: Number($('setCols').value),
        secs: Number($('setSecs').value),
        order: $('setOrder').value,
      },
    });
    setSubmitting(event.target, false);
    if (result.error) return showError('settingsError', result.error);
    $('dlgSettings').close();
    toast('Settings saved');
  });

  $('btnReset').addEventListener('click', async () => {
    const yes = await confirmAsk({
      title: 'Clear all check-ins?',
      text: 'Everyone goes back to Expected and the arrival times are erased. The guest list itself is kept. This cannot be undone.',
      ok: 'Clear check-ins',
    });
    if (!yes) return;
    const result = await attempt('reset', {});
    if (result.error) return showError('settingsError', result.error);
    $('dlgSettings').close();
    toast('All check-ins cleared');
  });

  $('btnExport').addEventListener('click', () => {
    const cell = (value) => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // stop Excel treating a name as a formula
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const stamp = (iso) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${A.pad(d.getMonth() + 1)}-${A.pad(d.getDate())} ${A.hhmm(d)}`;
    };
    const lines = [['No.', 'Name', 'Group', 'Status', 'Arrived at', 'Marked by']];
    for (const m of state.members) {
      lines.push([m.code, m.name, groupLabel(m.group), LABEL[m.status], m.arrivedAt ? stamp(m.arrivedAt) : '', m.by || '']);
    }
    const csv = `﻿${lines.map((line) => line.map(cell).join(',')).join('\r\n')}\r\n`;
    const link = el('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `attendance-${stamp(new Date(A.now())).slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  // Add people
  function openAdd(prefill) {
    if (!state) return;
    $('addNames').value = prefill || '';
    $('addGroup').replaceChildren(
      ...state.event.groups.map((g) => {
        const option = el('option', null, g.label);
        option.value = g.id;
        return option;
      }),
    );
    if (filter.group !== 'all') $('addGroup').value = filter.group;
    $('addGroupField').hidden = state.event.groups.length < 2;
    showError('addError', '');
    $('dlgAdd').showModal();
    $('addNames').focus();
  }

  $('btnAdd').addEventListener('click', () => openAdd(''));
  $('btnAddFromEmpty').addEventListener('click', () => openAdd($('search').value.trim()));

  $('formAdd').addEventListener('submit', async (event) => {
    event.preventDefault();
    const names = $('addNames').value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    if (!names.length) {
      showError('addError', 'Type at least one name.');
      return $('addNames').focus();
    }
    setSubmitting(event.target, true);
    const result = await attempt('add', { names, group: $('addGroup').value });
    setSubmitting(event.target, false);
    if (result.error) return showError('addError', result.error);
    $('dlgAdd').close();
    toast(names.length === 1 ? `${names[0]} added` : `${names.length} people added`);
  });

  // Edit person
  let editingId = null;

  function openEdit(id) {
    const m = member(id);
    if (!m) return;
    editingId = id;
    $('editTitle').textContent = `Edit ${m.code}`;
    $('editName').value = m.name;
    showError('editError', '');
    $('dlgEdit').showModal();
  }

  $('formEdit').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('editName').value.trim();
    if (!name) {
      showError('editError', 'Enter a name.');
      return $('editName').focus();
    }
    setSubmitting(event.target, true);
    const result = await attempt('rename', { id: editingId, name });
    setSubmitting(event.target, false);
    if (result.error) return showError('editError', result.error);
    $('dlgEdit').close();
    toast('Name updated');
  });

  $('btnRemove').addEventListener('click', async () => {
    const m = member(editingId);
    if (!m) return $('dlgEdit').close();
    const yes = await confirmAsk({
      title: `Remove ${m.name}?`,
      text: 'They disappear from this list and from the board. This cannot be undone.',
      ok: 'Remove',
    });
    if (!yes) return;
    const result = await attempt('remove', { id: m.id });
    if (result.error) return showError('editError', result.error);
    $('dlgEdit').close();
    toast(`${m.name} removed`);
  });

  // ---------- list, search and filter events ----------

  list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.closest('.person').dataset.id;
    if (button.dataset.act === 'edit') openEdit(id);
    else setStatus(id, button.dataset.act);
  });

  const search = $('search');

  search.addEventListener('input', () => {
    filter.q = search.value.trim().toLowerCase();
    render();
  });

  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && search.value) {
      search.value = '';
      filter.q = '';
      render();
    }
    if (event.key === 'Enter') {
      const id = $('enterHint').dataset.id;
      if (!id) return;
      event.preventDefault();
      search.value = '';
      filter.q = '';
      setStatus(id, 'arrived');
    }
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      search.focus();
    }
  });

  $('groupChips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    filter.group = chip.dataset.group;
    render();
  });

  for (const stat of document.querySelectorAll('.stat')) {
    stat.addEventListener('click', () => {
      filter.status = filter.status === stat.dataset.status ? 'all' : stat.dataset.status;
      render();
    });
  }

  $('btnClear').addEventListener('click', () => {
    search.value = '';
    filter.q = '';
    filter.group = 'all';
    filter.status = 'all';
    render();
    search.focus();
  });

  // ---------- live connection ----------

  A.connect(
    (next) => {
      // The desk is for logged-in volunteers only (the first visitor is asked to create a login).
      if (!next.auth.user) {
        location.replace(A.loginUrl());
        return;
      }
      state = next;
      $('loading').hidden = true;
      $('setup').hidden = true;
      $('desk').hidden = false;
      render();
      if ($('dlgUsers').open) renderUsers();
    },
    (ok, err) => {
      const conn = $('conn');
      conn.dataset.state = ok ? 'ok' : 'down';
      conn.textContent = ok ? 'Live' : 'Offline, retrying…';
      if (!ok && err && err.code === 'no_storage') {
        $('loading').hidden = true;
        $('desk').hidden = true;
        $('setupText').textContent = err.message;
        $('setup').hidden = false;
        conn.textContent = 'Setup needed';
      } else if (!ok && !state) {
        $('loading').textContent = 'Cannot reach the server. Retrying…';
      }
    },
  );

  // The reporting time shown in the header moves with the clock, so re-check regularly.
  setInterval(render, 20000);
})();
