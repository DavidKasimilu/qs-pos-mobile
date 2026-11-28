// Offline PIN unlock. The first time someone unlocks WITH internet, this device saves what it needs to let
// them unlock again offline: their profile (name, role, store) and a SALTED, SLOW hash of their PIN
// (PBKDF2, 100,000 rounds). The PIN itself is never stored. Wrong guesses are slowed down locally.
//
// Honest limit: a 4-digit PIN only has 10,000 possibilities, so anyone who can dig into this phone's browser
// storage could eventually work a PIN out. The server-side unlock (online) is the strong check; this offline
// copy exists so sales are not blocked when the internet is down.
const KEY = 'qs_pos_staff_cache';
const LOCK_KEY = 'qs_pos_offline_pin_lock';
const ITER = 100000;
const enc = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return b64(bits);
}

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
}
function save(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* storage full or unavailable */ }
}
function loadLock() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || '{}') || {}; } catch (e) { return {}; }
}

export const StaffCache = {
  get(userId) { return load()[userId] || null; },

  nameFor(userId) { return load()[userId]?.profile?.full_name || ''; },

  count(shopId) { return Object.values(load()).filter((e) => e.shop_id === shopId).length; },

  // called after a successful ONLINE unlock, while the PIN is still in hand
  async remember(profile, pin) {
    if (!profile?.id || !/^\d{4}$/.test(String(pin || ''))) return;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(pin, salt, ITER);
    const map = load();
    map[profile.id] = {
      id: profile.id,
      email: profile.email || '',
      shop_id: profile.shop_id || profile.shops?.id || null,
      profile,
      salt: b64(salt),
      hash,
      iter: ITER,
      saved_at: new Date().toISOString(),
    };
    save(map);
    localStorage.removeItem(LOCK_KEY);
  },

  // -> { ok: true, entry } | { ok: false, reason: 'empty' | 'invalid' | 'locked' | 'ambiguous', retryAfter }
  async verify(shopId, pin) {
    const lock = loadLock();
    if (lock.until && lock.until > Date.now()) {
      return { ok: false, reason: 'locked', retryAfter: Math.ceil((lock.until - Date.now()) / 1000) };
    }
    const entries = Object.values(load()).filter((e) => e.shop_id === shopId);
    if (!entries.length) return { ok: false, reason: 'empty' };

    const hits = [];
    for (const e of entries) {
      const h = await derive(pin, unb64(e.salt), e.iter || ITER);
      if (h === e.hash) hits.push(e);
    }
    if (hits.length === 1) {
      localStorage.removeItem(LOCK_KEY);
      return { ok: true, entry: hits[0] };
    }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous' };

    const fails = (lock.fails || 0) + 1;
    if (fails >= 5) {
      const lockCount = lock.lockCount || 0;
      const minutes = Math.min(60, 2 * 2 ** lockCount);
      localStorage.setItem(LOCK_KEY, JSON.stringify({ fails: 0, lockCount: lockCount + 1, until: Date.now() + minutes * 60000 }));
      return { ok: false, reason: 'locked', retryAfter: minutes * 60 };
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ ...lock, fails }));
    return { ok: false, reason: 'invalid' };
  },

  // a different store signed in on this device: forget the other store's people
  forgetOtherShops(shopId) {
    const map = load();
    let changed = false;
    Object.keys(map).forEach((id) => { if (map[id].shop_id !== shopId) { delete map[id]; changed = true; } });
    if (changed) save(map);
  },

  // best effort, online only: drop people who were deactivated and refresh names/roles
  async revalidate(supabase, shopId) {
    const map = load();
    const ids = Object.keys(map).filter((id) => map[id].shop_id === shopId);
    if (!ids.length) return;
    const { data, error } = await supabase.from('profiles').select('id, full_name, role, is_active, shop_id').in('id', ids);
    if (error || !data) return;
    let changed = false;
    data.forEach((p) => {
      const e = map[p.id];
      if (!e) return;
      if (p.is_active === false || (p.shop_id && p.shop_id !== shopId)) { delete map[p.id]; changed = true; return; }
      if (e.profile.full_name !== p.full_name || e.profile.role !== p.role) {
        e.profile = { ...e.profile, full_name: p.full_name, role: p.role };
        changed = true;
      }
    });
    if (changed) save(map);
  },
};
