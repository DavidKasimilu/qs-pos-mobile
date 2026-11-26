// Device preferences (kept on this phone): haptics, screen wake lock, printer options.
const KEY = 'qs_pos_prefs';
const DEFAULTS = { wakelock: 'enabled', haptics: 'enabled', printerType: 'system', paperWidth: '58', autoPrint: 'yes' };

export const Prefs = {
  get() {
    try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}')) }; }
    catch (e) { return { ...DEFAULTS }; }
  },
  set(patch) {
    const next = { ...this.get(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* storage unavailable */ }
    return next;
  },
};

let wakeSentinel = null;
let globalBound = false;

export const Device = {
  vibrate(pattern) {
    if (Prefs.get().haptics !== 'enabled') return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
  },
  tap() { this.vibrate(12); },
  success() { this.vibrate([40, 40, 40]); },
  warn() { this.vibrate([80, 50, 80]); },

  // Keeps the screen on while the POS is open; the browser drops the lock when the tab is hidden, so re-request it.
  async applyWakeLock() {
    const want = Prefs.get().wakelock === 'enabled';
    if (!want) {
      try { await wakeSentinel?.release(); } catch (e) { /* ignore */ }
      wakeSentinel = null;
      return;
    }
    if (!('wakeLock' in navigator) || wakeSentinel || document.visibilityState !== 'visible') return;
    try {
      wakeSentinel = await navigator.wakeLock.request('screen');
      wakeSentinel.addEventListener('release', () => { wakeSentinel = null; });
    } catch (e) {
      console.warn('[WakeLock]', e.message);
    }
  },

  initGlobal() {
    if (globalBound) return;
    globalBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.applyWakeLock();
    });
    // light tap feedback on buttons and tappable rows
    document.addEventListener('click', (e) => {
      if (e.target.closest('button, .product-list-row, .receipt-row, .pin-key-btn, .drawer-link')) this.tap();
    }, true);
  },
};
