// Shift management for the mobile POS.
// One shift per SHOP (shared by every staff member and device). The database decides whether a sale
// may be saved; this module makes the rules visible: start-shift prompt, shift screen, closing, polling.
import { supabase, Auth } from './auth.js';
import { SyncEngine } from './sync.js';
import { IDB } from './idb.js';

const CACHE_KEY = 'qs_pos_shift_cache';
const POLL_MS = 45000;
const MANAGER_ROLES = ['admin', 'owner', 'manager'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const currency = () => Auth.currentShop?.currency || 'KES';
const isBusinessError = (err) => /^(P0001|42501|22|23)/.test(String(err?.code || ''));
const isMissingFunction = (err) =>
  /PGRST202|42883/.test(String(err?.code || '')) || /could not find the function|does not exist/i.test(String(err?.message || ''));

// ---------------------------------------------------------------------------
// A tiny reusable popup (also used for the "admin: use your password" message)
// ---------------------------------------------------------------------------
export function showNotice({ title, message, actions }) {
  document.getElementById('qs-notice')?.remove();
  const buttons = (actions && actions.length ? actions : [{ label: 'OK', primary: true }]);
  const wrap = document.createElement('div');
  wrap.id = 'qs-notice';
  wrap.style.cssText = 'position:fixed; inset:0; z-index:10050; background:rgba(15,23,42,.55); display:flex; align-items:center; justify-content:center; padding:24px;';
  wrap.innerHTML = `
    <div style="background:#fff; border-radius:14px; max-width:360px; width:100%; padding:22px; box-shadow:0 20px 50px rgba(0,0,0,.25);">
      <h3 style="margin:0 0 8px; font-size:1.05rem; color:#0f172a;">${esc(title)}</h3>
      <p style="margin:0 0 18px; font-size:0.92rem; line-height:1.45; color:#475569; white-space:pre-line;">${esc(message)}</p>
      <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap;"></div>
    </div>`;
  const row = wrap.querySelector('div > div:last-child');
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    btn.style.cssText = b.primary
      ? 'background:#0f766e; color:#fff; border:0; border-radius:8px; padding:10px 16px; font-weight:700; font-size:0.85rem;'
      : 'background:#f1f5f9; color:#334155; border:0; border-radius:8px; padding:10px 16px; font-weight:600; font-size:0.85rem;';
    btn.onclick = () => { wrap.remove(); if (b.onClick) b.onClick(); };
    row.appendChild(btn);
  });
  document.body.appendChild(wrap);
}

export const Shift = {
  state: { loaded: false, required: false, shift: null, unavailable: false },
  active: false,
  mounted: false,
  timer: null,
  closingLocally: false,

  // ------------------------------------------------------------------ rules
  allowsSales() {
    if (!this.state.loaded) return false;                 // unknown: do not sell
    if (this.state.unavailable) return true;              // server has no shift feature yet: do not brick the POS
    return !this.state.required || !!this.state.shift;
  },

  canCloseCurrent() {
    const s = this.state.shift;
    if (!s) return false;
    const role = String(Auth.currentProfile?.role || '').toLowerCase();
    return MANAGER_ROLES.includes(role) || s.opened_by === Auth.currentUser?.id;
  },

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this.active = true;
    this.mount();
    await this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (navigator.onLine && document.visibilityState !== 'hidden') this.refresh(); }, POLL_MS);
  },

  stop() {
    this.active = false;
    clearInterval(this.timer);
    window.__qsSalesBlocked = false;
    document.getElementById('qs-shift-gate')?.style.setProperty('display', 'none');
  },

  readCache(shopId) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return c && c.shopId === shopId ? c : null;
    } catch (e) { return null; }
  },

  apply(next) {
    const prevShiftId = this.state.shift?.id || null;
    this.state = next;
    window.__qsSalesBlocked = !this.allowsSales();

    const shopId = Auth.currentShop?.id;
    if (shopId && next.loaded && !next.unavailable) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ shopId, required: next.required, shift: next.shift, at: Date.now() })); } catch (e) { /* ignore */ }
    }

    // someone closed the shift on another device
    if (prevShiftId && !next.shift && next.required && !this.closingLocally && this.active) {
      showNotice({ title: 'Shift closed', message: 'The shift for this store was closed. Start a new shift to continue selling.' });
    }
    this.render();
  },

  async refresh() {
    const shopId = Auth.currentShop?.id;
    if (!shopId) return;

    if (navigator.onLine) {
      try {
        const { data, error } = await supabase.rpc('get_shift_state', { p_shop_id: shopId });
        if (error) throw error;
        this.apply({ loaded: true, required: !!data.required, shift: data.shift || null, unavailable: false });
        return;
      } catch (err) {
        if (isMissingFunction(err)) {
          this.apply({ loaded: true, required: false, shift: null, unavailable: true });
          return;
        }
        console.warn('[Shift] could not reach the server, using the last known state:', err.message);
      }
    }

    const cached = this.readCache(shopId);
    if (cached) this.apply({ loaded: true, required: !!cached.required, shift: cached.shift || null, unavailable: false });
    else this.apply({ loaded: false, required: true, shift: null, unavailable: false });
  },

  // ------------------------------------------------------------------ actions
  async startShift(openingCash, notes) {
    const shopId = Auth.currentShop?.id;
    const { data, error } = await supabase.rpc('open_shift', {
      p_shop_id: shopId,
      p_opening_cash: openingCash,
      p_notes: notes || null,
      p_device: String(navigator.userAgent || '').slice(0, 120),
    });
    if (error) throw new Error(error.message);
    this.apply({ loaded: true, required: true, shift: data.shift, unavailable: false });
    return data;
  },

  async closeShift(countedCash, notes) {
    const s = this.state.shift;
    if (!s) throw new Error('There is no open shift.');

    // push every pending sale first so the shift totals are complete
    try { await SyncEngine.syncPendingData(); } catch (e) { /* offline: handled below */ }
    const pending = await IDB.getPendingOrders();
    if (pending.length && !confirm(`${pending.length} sale(s) on this device have not synced yet.\nThey will still be counted once they sync. Close the shift anyway?`)) {
      return null;
    }

    this.closingLocally = true;
    try {
      const { data, error } = await supabase.rpc('close_shift', {
        p_shift_id: s.id, p_actual_cash: countedCash, p_notes: notes || null,
      });
      if (error) throw new Error(error.message);
      await this.refresh();
      return data.shift;
    } finally {
      this.closingLocally = false;
    }
  },

  // ------------------------------------------------------------------ UI
  mount() {
    if (this.mounted) return;
    this.mounted = true;

    // 1) the "Start shift" gate (full screen, blocks everything until a shift exists)
    const gate = document.createElement('div');
    gate.id = 'qs-shift-gate';
    gate.style.cssText = 'position:fixed; inset:0; z-index:9500; background:#f1f5f9; display:none; align-items:center; justify-content:center; padding:20px; overflow-y:auto;';
    gate.innerHTML = `
      <div style="background:#fff; border-radius:16px; width:100%; max-width:380px; padding:26px; box-shadow:0 10px 40px rgba(15,23,42,.12);">
        <div style="font-size:0.75rem; font-weight:800; letter-spacing:.08em; color:#0f766e;">NO SHIFT OPEN</div>
        <h2 style="margin:6px 0 4px; font-size:1.4rem; color:#0f172a;">Start a shift</h2>
        <p id="qs-gate-sub" style="margin:0 0 18px; font-size:0.85rem; color:#64748b;"></p>
        <label style="display:block; font-size:0.75rem; font-weight:700; color:#475569; margin-bottom:6px;">Opening cash in the drawer (<span id="qs-gate-cur">KES</span>)</label>
        <input id="qs-gate-cash" type="number" inputmode="decimal" min="0" step="0.01" value="0" style="width:100%; box-sizing:border-box; padding:12px; font-size:1.1rem; border:1.5px solid #cbd5e1; border-radius:10px; margin-bottom:14px;" />
        <label style="display:block; font-size:0.75rem; font-weight:700; color:#475569; margin-bottom:6px;">Note (optional)</label>
        <input id="qs-gate-notes" type="text" maxlength="200" placeholder="e.g. morning shift" style="width:100%; box-sizing:border-box; padding:12px; font-size:0.95rem; border:1.5px solid #cbd5e1; border-radius:10px; margin-bottom:18px;" />
        <p id="qs-gate-msg" style="display:none; font-size:0.8rem; color:#b45309; background:#fef3c7; padding:8px 10px; border-radius:8px; margin:0 0 14px;"></p>
        <button id="qs-gate-start" type="button" style="width:100%; padding:14px; border:0; border-radius:10px; background:#0f766e; color:#fff; font-weight:800; font-size:0.95rem;">START SHIFT</button>
        <button id="qs-gate-lock" type="button" style="width:100%; margin-top:10px; padding:12px; border:0; border-radius:10px; background:#f1f5f9; color:#334155; font-weight:700; font-size:0.85rem;">LOCK TERMINAL / SWITCH USER</button>
      </div>`;
    document.body.appendChild(gate);

    gate.querySelector('#qs-gate-start').onclick = async () => {
      const btn = gate.querySelector('#qs-gate-start');
      const cash = parseFloat(gate.querySelector('#qs-gate-cash').value || '0');
      if (Number.isNaN(cash) || cash < 0) return alert('Enter the opening cash (0 or more).');
      btn.disabled = true; btn.textContent = 'STARTING...';
      try {
        const res = await this.startShift(cash, gate.querySelector('#qs-gate-notes').value.trim());
        if (!res.created) showNotice({ title: 'Shift already running', message: 'A shift was already started for this store. You have joined it.' });
        gate.querySelector('#qs-gate-cash').value = '0';
        gate.querySelector('#qs-gate-notes').value = '';
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'START SHIFT';
      }
    };
    gate.querySelector('#qs-gate-lock').onclick = () => window.dispatchEvent(new CustomEvent('qs:lock-terminal'));

    // 2) shift status strip above the charge bar
    const strip = document.createElement('div');
    strip.id = 'qs-shift-strip';
    strip.style.cssText = 'display:none; font-size:0.75rem; font-weight:700; text-align:center; padding:5px 8px; cursor:pointer;';
    strip.onclick = () => this.openModal();
    const pill = document.getElementById('connection-status-pill');
    if (pill && pill.parentNode) pill.parentNode.insertBefore(strip, pill);
    else document.body.appendChild(strip);

    // 3) menu entries: 3-dot menu + side drawer
    const overflow = document.getElementById('overflow-popup');
    const lockItem = document.getElementById('opt-lock-terminal');
    if (overflow && lockItem && !document.getElementById('opt-shift')) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'overflow-menu-item';
      item.id = 'opt-shift';
      item.innerHTML = '<i data-lucide="clock" style="width:16px; height:16px;"></i><span>Shift</span>';
      item.onclick = (e) => { e.preventDefault(); overflow.classList.add('hidden'); this.openModal(); };
      overflow.insertBefore(item, lockItem);
      if (window.lucide) window.lucide.createIcons({ root: overflow });
    }

    const backofficeLink = document.getElementById('link-goto-backoffice');
    if (backofficeLink && !document.getElementById('link-open-shift')) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'drawer-link';
      link.id = 'link-open-shift';
      link.innerHTML = '<i data-lucide="clock" style="width:18px; height:18px;"></i><span>Shift</span>';
      link.onclick = (e) => {
        e.preventDefault();
        document.getElementById('side-drawer')?.classList.remove('active');
        document.getElementById('drawer-backdrop')?.classList.remove('active');
        this.openModal();
      };
      backofficeLink.parentNode.insertBefore(link, backofficeLink);
      if (window.lucide) window.lucide.createIcons({ root: link });
    }

    window.addEventListener('qs:need-shift', () => this.render());
    window.addEventListener('online', () => this.active && this.refresh());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.active) this.refresh(); });
  },

  render() {
    if (!this.mounted) return;
    const gate = document.getElementById('qs-shift-gate');
    const strip = document.getElementById('qs-shift-strip');
    const need = this.active && this.state.loaded && !this.state.unavailable && this.state.required && !this.state.shift;
    const unknown = this.active && !this.state.loaded;

    if (gate) {
      gate.style.display = need || unknown ? 'flex' : 'none';
      gate.querySelector('#qs-gate-sub').textContent =
        `${Auth.currentShop?.name || 'Store'} - ${Auth.currentProfile?.full_name || Auth.currentUser?.email || ''}`;
      gate.querySelector('#qs-gate-cur').textContent = currency();
      const msg = gate.querySelector('#qs-gate-msg');
      const startBtn = gate.querySelector('#qs-gate-start');
      if (unknown) {
        msg.style.display = 'block';
        msg.textContent = 'Connect to the internet to check the shift for this store.';
        startBtn.disabled = true;
      } else if (!navigator.onLine) {
        msg.style.display = 'block';
        msg.textContent = 'You are offline. Connect to the internet to start a shift.';
        startBtn.disabled = true;
      } else {
        msg.style.display = 'none';
        startBtn.disabled = false;
      }
    }

    if (strip) {
      if (this.active && this.state.loaded && !this.state.unavailable && this.state.required) {
        strip.style.display = 'block';
        if (this.state.shift) {
          strip.style.background = '#dcfce7'; strip.style.color = '#166534';
          strip.textContent = `Shift open since ${new Date(this.state.shift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${this.state.shift.opened_by_name || ''}`;
        } else {
          strip.style.background = '#fee2e2'; strip.style.color = '#991b1b';
          strip.textContent = 'No shift open - tap to start';
        }
      } else {
        strip.style.display = 'none';
      }
    }
  },

  async openModal() {
    await this.refresh();
    if (!this.state.shift) { this.render(); return; }          // the gate takes over

    const s = this.state.shift;
    const t = s.totals || {};
    const cur = esc(currency());
    const row = (label, value, strong) => `
      <div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #f1f5f9; font-size:0.9rem;">
        <span style="color:#64748b;">${label}</span><span style="${strong ? 'font-weight:800; color:#0f172a;' : 'font-weight:600; color:#334155;'}">${value}</span>
      </div>`;

    document.getElementById('qs-shift-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'qs-shift-modal';
    wrap.style.cssText = 'position:fixed; inset:0; z-index:9700; background:rgba(15,23,42,.55); display:flex; align-items:flex-end; justify-content:center;';
    wrap.innerHTML = `
      <div style="background:#fff; width:100%; max-width:520px; max-height:92vh; overflow-y:auto; border-radius:18px 18px 0 0; padding:20px 20px 28px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <h3 style="margin:0; font-size:1.15rem;">Current shift <span style="font-size:0.7rem; background:#dcfce7; color:#166534; padding:3px 8px; border-radius:99px; margin-left:6px; vertical-align:middle;">OPEN</span></h3>
          <button type="button" id="qs-shift-x" style="border:0; background:#f1f5f9; border-radius:8px; padding:6px 12px; font-weight:700;">Close</button>
        </div>
        ${row('Started', esc(when(s.opened_at)))}
        ${row('Started by', esc(s.opened_by_name || '-'))}
        ${row('Opening cash', `${money(s.opening_cash)} ${cur}`)}
        <div style="height:10px;"></div>
        ${row('Sales (orders)', esc(t.orders_count ?? 0))}
        ${row('Total sales', `${money(t.total_sales)} ${cur}`, true)}
        ${row('Cash payments', `${money(t.cash_sales)} ${cur}`)}
        ${row('Other payments', `${money(t.other_payments)} ${cur}`)}
        ${row('On credit (unpaid)', `${money(t.credit_sales)} ${cur}`)}
        ${row('Cash in / out', `${money(t.cash_in)} / ${money(t.cash_out)}`)}
        ${row('Expected cash in drawer', `${money(t.expected_cash)} ${cur}`, true)}
        <div id="qs-shift-actions" style="margin-top:18px;"></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#qs-shift-x').onclick = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };

    const actions = wrap.querySelector('#qs-shift-actions');
    if (!this.canCloseCurrent()) {
      actions.innerHTML = '<p style="font-size:0.8rem; color:#64748b; margin:0;">Only the person who started this shift, or a manager, can close it.</p>';
      return;
    }
    actions.innerHTML = `<button type="button" id="qs-shift-close-btn" style="width:100%; padding:14px; border:0; border-radius:10px; background:#b91c1c; color:#fff; font-weight:800;">CLOSE SHIFT / END OF DAY</button>`;
    actions.querySelector('#qs-shift-close-btn').onclick = () => {
      actions.innerHTML = `
        <label style="display:block; font-size:0.75rem; font-weight:700; color:#475569; margin-bottom:6px;">Cash counted in the drawer (${cur})</label>
        <input id="qs-close-cash" type="number" inputmode="decimal" min="0" step="0.01" placeholder="${money(t.expected_cash)}" style="width:100%; box-sizing:border-box; padding:12px; font-size:1.1rem; border:1.5px solid #cbd5e1; border-radius:10px; margin-bottom:12px;" />
        <input id="qs-close-notes" type="text" maxlength="200" placeholder="Note (optional)" style="width:100%; box-sizing:border-box; padding:12px; border:1.5px solid #cbd5e1; border-radius:10px; margin-bottom:14px;" />
        <button type="button" id="qs-close-confirm" style="width:100%; padding:14px; border:0; border-radius:10px; background:#b91c1c; color:#fff; font-weight:800;">CONFIRM CLOSE</button>`;
      actions.querySelector('#qs-close-confirm').onclick = async () => {
        const counted = parseFloat(actions.querySelector('#qs-close-cash').value);
        if (Number.isNaN(counted) || counted < 0) return alert('Enter the cash counted in the drawer.');
        const btn = actions.querySelector('#qs-close-confirm');
        btn.disabled = true; btn.textContent = 'CLOSING...';
        try {
          const closed = await this.closeShift(counted, actions.querySelector('#qs-close-notes').value.trim());
          if (!closed) { btn.disabled = false; btn.textContent = 'CONFIRM CLOSE'; return; }
          wrap.remove();
          const diff = Number(closed.cash_variance) || 0;
          showNotice({
            title: 'Shift closed',
            message: `Total sales: ${money(closed.totals?.total_sales)} ${currency()}\nExpected cash: ${money(closed.expected_cash)}\nCounted cash: ${money(closed.actual_cash)}\nDifference: ${diff > 0 ? '+' : ''}${money(diff)} ${currency()}`,
          });
        } catch (err) {
          alert(err.message);
          btn.disabled = false; btn.textContent = 'CONFIRM CLOSE';
        }
      };
    };
  },
};
