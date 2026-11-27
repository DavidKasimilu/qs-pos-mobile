// Simple in-app dialogs that replace the browser's alert() / confirm() popups.
//   UI.alert('message')                      -> shows the message with an OK button
//   if (await UI.confirm('Delete it?')) ...   -> OK / Cancel, resolves true or false
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'qs-dialog-backdrop';
    wrap.innerHTML = `
      <div class="qs-dialog" role="alertdialog" aria-modal="true">
        ${title ? `<h3 class="qs-dialog-title">${esc(title)}</h3>` : ''}
        <p class="qs-dialog-msg">${esc(message)}</p>
        <div class="qs-dialog-actions"></div>
      </div>`;
    const row = wrap.querySelector('.qs-dialog-actions');
    const done = (value) => { wrap.remove(); resolve(value); };
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.className = `qs-dialog-btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`;
      btn.onclick = () => done(b.value);
      row.appendChild(btn);
    });
    document.body.appendChild(wrap);
    row.lastElementChild?.focus();
  });
}

export const UI = {
  alert(message, opts = {}) {
    return dialog({ title: opts.title, message: String(message ?? ''), buttons: [{ label: opts.okLabel || 'OK', primary: true, value: true }] });
  },
  confirm(message, opts = {}) {
    return dialog({
      title: opts.title,
      message: String(message ?? ''),
      buttons: [
        { label: opts.cancelLabel || 'Cancel', value: false },
        { label: opts.okLabel || 'OK', primary: true, danger: !!opts.danger, value: true },
      ],
    });
  },
};

// any remaining alert() call (including ones in future code) uses the in-app dialog too
window.alert = (message) => { UI.alert(message); };
