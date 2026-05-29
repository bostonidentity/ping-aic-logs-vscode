(function () {
  const vscode = acquireVsCodeApi();
  const init = window.__INIT__ || { mode: 'add', name: '', url: '' };

  const $ = (id) => document.getElementById(id);
  const titleEl = $('title');
  const hintEl = $('hint');
  const errorEl = $('error');
  const form = $('form');
  const nameField = $('name');
  const urlField = $('url');
  const keyField = $('key');
  const secretField = $('secret');

  if (init.mode === 'edit') {
    titleEl.textContent = 'Edit: ' + init.name;
    hintEl.textContent = 'Leave key and secret blank to keep the current values.';
    hintEl.hidden = false;
    nameField.value = init.name;
    urlField.value = init.url;
    keyField.placeholder = '••••••• (leave blank to keep)';
    secretField.placeholder = '••••••• (leave blank to keep)';
    setTimeout(() => urlField.focus(), 0);
  } else {
    titleEl.textContent = 'Add Environment';
    setTimeout(() => nameField.focus(), 0);
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function submit() {
    errorEl.hidden = true;
    const name = nameField.value.trim();
    const url = urlField.value.trim();
    const key = keyField.value;
    const secret = secretField.value;
    if (!name) return showError('Environment name is required.');
    if (!url.startsWith('https://')) return showError('URL must start with https://');
    if (init.mode === 'add' && (!key || !secret)) {
      return showError('API key and secret are required for new environments.');
    }
    vscode.postMessage({ type: 'submit', payload: { name, url, key, secret } });
  }

  function cancel() {
    vscode.postMessage({ type: 'cancel' });
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  $('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
  });
})();
