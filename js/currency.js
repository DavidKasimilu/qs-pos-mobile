// Single source of truth for the shop currency: formatting, settings and sync.
// The currency lives on the SHOP row (shops.currency), so every device and the back-office share it.
import { Auth, supabase } from './auth.js';
import { CONFIG } from './config.js';

export const CURRENCIES = [
  { code: 'KES', name: 'Kenyan Shilling' },
  { code: 'UGX', name: 'Ugandan Shilling' },
  { code: 'TZS', name: 'Tanzanian Shilling' },
  { code: 'RWF', name: 'Rwandan Franc' },
  { code: 'BIF', name: 'Burundian Franc' },
  { code: 'SSP', name: 'South Sudanese Pound' },
  { code: 'ETB', name: 'Ethiopian Birr' },
  { code: 'NGN', name: 'Nigerian Naira' },
  { code: 'GHS', name: 'Ghanaian Cedi' },
  { code: 'ZAR', name: 'South African Rand' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'INR', name: 'Indian Rupee' },
];

const MANAGER_ROLES = ['admin', 'owner', 'manager'];
const LOCAL_KEY = 'qs_pos_currency';

export const Currency = {
  get code() {
    return Auth.currentShop?.currency || localStorage.getItem(LOCAL_KEY) || 'KES';
  },

  fmt(n) {
    return (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  withCode(n) {
    return `${this.fmt(n)} ${this.code}`;
  },

  canEdit() {
    return MANAGER_ROLES.includes(String(Auth.currentProfile?.role || '').toLowerCase());
  },

  // Saves the currency on the shop (all devices + back-office), updates this device, and tells the UI.
  async set(code) {
    if (!CURRENCIES.some((c) => c.code === code)) throw new Error('Unknown currency.');
    if (code === this.code) return;
    if (!this.canEdit()) throw new Error('Only an administrator or manager can change the store currency.');
    if (!navigator.onLine) throw new Error('Connect to the internet to change the store currency.');
    const shopId = Auth.currentShop?.id;
    if (!shopId) throw new Error('No store is loaded.');

    const { data, error } = await supabase.from('shops').update({ currency: code }).eq('id', shopId).select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) throw new Error('The currency was not saved (no permission to edit this store).');

    Auth.currentShop.currency = code;
    try {
      localStorage.setItem(LOCAL_KEY, code);
      const cached = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE) || 'null');
      if (cached) {
        cached.shops = { ...(cached.shops || {}), currency: code };
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE, JSON.stringify(cached));
      }
    } catch (e) { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('currency-changed', { detail: { code } }));
  },

  // Fills the Settings dropdown and refreshes every static label that shows the currency.
  applyLabels() {
    const code = this.code;
    const pos = document.getElementById('lbl-pos-currency');
    if (pos) pos.textContent = code;

    document.querySelectorAll('#tab-sales-cash label').forEach((l) => {
      if (/^Amount/.test(l.textContent.trim())) l.textContent = `Amount (${code})`;
    });

    const sel = document.getElementById('set-currency');
    if (sel) {
      if (!sel.options.length || sel.dataset.filled !== '1') {
        sel.innerHTML = CURRENCIES.map((c) => `<option value="${c.code}">${c.code} - ${c.name}</option>`).join('');
        sel.dataset.filled = '1';
      }
      if (![...sel.options].some((o) => o.value === code)) {
        sel.insertAdjacentHTML('afterbegin', `<option value="${code}">${code}</option>`);
      }
      sel.value = code;
      const editable = this.canEdit();
      sel.disabled = !editable;
      const hint = document.getElementById('set-currency-hint');
      if (hint) {
        hint.textContent = editable
          ? 'Applies to this store on every device, receipts and reports.'
          : 'Set by your store administrator.';
      }
    }
  },
};
