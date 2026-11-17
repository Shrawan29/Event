/* Login page. While no login exists yet, the same form creates the first one. */
(() => {
  'use strict';

  const A = window.Arrivals;
  const $ = (id) => document.getElementById(id);

  // Only ever return to a page on this site.
  const wanted = new URLSearchParams(location.search).get('next') || '/checkin';
  const next = /^\/(?!\/)[\w\-./]*$/.test(wanted) ? wanted : '/checkin';

  let creating = false; // true while the very first login is being created

  function showError(message) {
    $('error').textContent = message || '';
    $('error').hidden = !message;
  }

  function showForm(setup) {
    creating = setup;
    $('title').textContent = setup ? 'Create the first login' : 'Log in';
    $('intro').textContent = setup
      ? 'Nobody can log in yet. Choose an ID and a password for yourself; you can add more logins afterwards from the desk.'
      : 'Use the ID and password you were given.';
    $('submit').textContent = setup ? 'Create login' : 'Log in';
    $('idHelp').hidden = !setup;
    $('passHelp').hidden = !setup;
    $('password').autocomplete = setup ? 'new-password' : 'current-password';
    $('wait').hidden = true;
    $('form').hidden = false;
    $('userId').focus();
  }

  $('toggle').addEventListener('click', () => {
    const hidden = $('password').type === 'password';
    $('password').type = hidden ? 'text' : 'password';
    $('toggle').textContent = hidden ? 'Hide' : 'Show';
    $('toggle').setAttribute('aria-pressed', String(hidden));
  });

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('userId').value.trim();
    const password = $('password').value;
    if (!id) {
      showError('Enter your ID.');
      return $('userId').focus();
    }
    if (!password) {
      showError('Enter your password.');
      return $('password').focus();
    }
    showError('');
    $('submit').disabled = true;
    try {
      await A.post(creating ? 'setup' : 'login', { id, password });
      location.replace(next);
    } catch (err) {
      $('submit').disabled = false;
      if (err.code === 'setup_done') {
        showForm(false);
        showError('Someone has just created the first login. Log in with your ID and password.');
      } else {
        showError(err.message);
        (err.code === 'login' ? $('password') : $('userId')).focus();
      }
    }
  });

  fetch('/api', { cache: 'no-store' })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The server is not ready.');
      if (data.auth.user) location.replace(next);
      else showForm(data.auth.setup);
    })
    .catch((err) => {
      $('wait').textContent = `${err.message} Refresh the page to try again.`;
    });
})();
