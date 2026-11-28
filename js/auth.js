import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { CONFIG } from './config.js';
import { IDB } from './idb.js';
import { SyncEngine } from './sync.js';
import { StaffCache } from './staff-cache.js';

// Direct Supabase Client Initialization
export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const Auth = {
  currentUser: null,
  currentProfile: null,
  currentShop: null,
  lastRejection: '',

  getCurrencyForCountry(country) {
    const map = {
      'Kenya': 'KES',
      'Tanzania': 'TZS',
      'Uganda': 'UGX',
      'Rwanda': 'RWF',
      'Burundi': 'BIF',
      'South Sudan': 'SSP'
    };
    return map[country] || 'KES';
  },

  async syncSession() {
    try {
      if (navigator.onLine) {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session?.user) {
          return this.restoreCachedSession();
        }

        this.currentUser = session.user;
        this.lastRejection = '';

        // Fetch user profile and assigned shop (row-level security returns ONLY this user's own company)
        const { data: profile } = await supabase
          .from('profiles')
          .select('*, shops(*)')
          .eq('id', this.currentUser.id)
          .maybeSingle();

        // No guessing: without an active profile attached to a company and a shop there is no access.
        // (The old code fell back to "the first shop in the database".)
        if (!profile || profile.is_active === false || !profile.organization_id || !profile.shops) {
          this.lastRejection = !profile
            ? 'Your account is not linked to a store yet. Contact your administrator.'
            : profile.is_active === false
              ? 'This account has been deactivated. Contact your administrator.'
              : 'No store is assigned to your account. Contact your administrator.';
          try { await supabase.auth.signOut(); } catch (e) { /* offline */ }
          this.currentUser = null;
          this.currentProfile = null;
          this.currentShop = null;
          localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_USER);
          localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE);
          localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP);
          return null;
        }

        // Catalog/customer caches belong to the SHOP (several staff share one tablet). A different shop => wipe.
        const cacheShop = localStorage.getItem('qs_pos_cache_shop');
        if (cacheShop && cacheShop !== profile.shops.id) {
          await IDB.clearReadCaches();
          localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_CART);
          localStorage.removeItem('qs_pos_shift_cache');
        }
        localStorage.setItem('qs_pos_cache_shop', profile.shops.id);

        this.currentProfile = profile;
        this.currentShop = profile.shops;

        // Cache session identity locally for uninterrupted offline operation
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_USER, JSON.stringify(this.currentUser));
        if (this.currentProfile) {
          localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE, JSON.stringify(this.currentProfile));
        }
        if (this.currentShop) {
          localStorage.setItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP, this.currentShop.id);
        }

        // keep the offline PIN list tidy (only this store's people) and in step with the back-office
        StaffCache.forgetOtherShops(this.currentShop.id);
        StaffCache.revalidate(supabase, this.currentShop.id).catch(() => {});

        // someone unlocked this device offline: they stay the active person, while the saved login is only used to sync
        this.applyOperator();

        // Refresh local IndexedDB catalog with current shop products
        if (this.currentShop?.id) {
          await this.refreshLocalCatalog(this.currentShop.id);
          SyncEngine.startBackgroundSync();
        }

        return { user: this.currentUser, profile: this.currentProfile, shop: this.currentShop };
      } else {
        return this.restoreCachedSession();
      }
    } catch (err) {
      console.warn('[Auth] Network error, restoring offline cached session:', err);
      return this.restoreCachedSession();
    }
  },

  restoreCachedSession() {
    try {
      const cachedUser = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_USER) || 'null');
      const cachedProfile = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE) || 'null');

      if (cachedProfile || cachedUser) {
        this.currentUser = cachedUser;
        this.currentProfile = cachedProfile;
        
        const country = cachedProfile?.country || 'Kenya';
        const defaultCurrency = this.getCurrencyForCountry(country);

        this.currentShop = cachedProfile?.shops || {
          id: localStorage.getItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP) || 'offline_shop',
          name: cachedProfile?.full_name ? `${cachedProfile.full_name}'s Shop` : 'QuickSell Terminal',
          currency: defaultCurrency
        };

        this.applyOperator();
        return { user: this.currentUser, profile: this.currentProfile, shop: this.currentShop };
      }
    } catch (e) {
      console.warn('[Auth] Error restoring offline session:', e);
    }
    return null;
  },

  // Offline unlock: the person who is working now. The Supabase login on the device (whoever signed in last)
  // is kept only so offline sales can be synced; every sale is recorded under the person who made it.
  applyOperator() {
    try {
      const op = JSON.parse(localStorage.getItem('qs_pos_operator') || 'null');
      if (!op?.id) return;
      const entry = StaffCache.get(op.id);
      const shopId = this.currentShop?.id || entry?.shop_id;
      if (!entry || (shopId && entry.shop_id !== shopId)) { localStorage.removeItem('qs_pos_operator'); return; }
      this.currentUser = { id: entry.id, email: entry.email };
      this.currentProfile = { ...entry.profile, shops: this.currentShop || entry.profile.shops };
      this.currentShop = this.currentShop || entry.profile.shops || null;
    } catch (e) { /* ignore */ }
  },

  async signIn(email, password) {
    localStorage.removeItem('qs_pos_operator');
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const state = await this.syncSession();
    if (!state) throw new Error(this.lastRejection || 'Sign-in could not be completed.');
    return data;
  },

  // Email + 4-digit PIN. The server checks the PIN (hashed, lockouts, throttling) and returns a one-time
  // token that is exchanged for a normal session, so row-level security applies exactly as with a password.
  // Lock screen: the device knows its store, the person only types their 4-digit PIN.
  async signInWithShopPin(shopId, pin) {
    return this._pinLogin({ action: 'login', shop_id: shopId, pin }, 'Incorrect PIN, or too many attempts. Please try again later.');
  },

  // Lock screen: online -> the server checks the PIN (and this device learns the person for offline use);
  // no connection -> the PIN is checked against what this device saved during an earlier online unlock.
  async unlockWithPin(shopId, pin) {
    if (navigator.onLine) {
      try {
        await this.signInWithShopPin(shopId, pin);
        return 'online';
      } catch (e) {
        if (!e.offline) throw e;      // the server answered (wrong PIN, locked...): show that
      }
    }
    await this.unlockOffline(shopId, pin);
    return 'offline';
  },

  async unlockOffline(shopId, pin) {
    const r = await StaffCache.verify(shopId, pin);
    if (!r.ok) {
      if (r.reason === 'empty') throw new Error('No PINs are saved on this device yet. Connect to the internet and unlock once with your PIN, then it will also work offline.');
      if (r.reason === 'locked') { const m = Math.max(1, Math.ceil((r.retryAfter || 60) / 60)); throw new Error(`Too many wrong PINs. Try again in ${m} minute${m === 1 ? '' : 's'}.`); }
      if (r.reason === 'ambiguous') throw new Error('Two employees share this PIN. Ask your manager to give one of you a different PIN.');
      throw new Error('Incorrect PIN. (You are offline: only people who already unlocked once with internet can unlock.)');
    }
    const e = r.entry;
    localStorage.setItem('qs_pos_operator', JSON.stringify({ id: e.id }));
    this.currentUser = { id: e.id, email: e.email };
    this.currentProfile = e.profile;
    this.currentShop = e.profile.shops || this.currentShop;
    return true;
  },

  async _pinLogin(body, GENERIC) {
    let res;
    try {
      res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/pin-auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: CONFIG.SUPABASE_ANON_KEY,
          // The caller is not signed in yet, so the anon key doubles as the Authorization token.
          // Supabase's platform gateway checks this header for a validly-signed JWT BEFORE our function
          // code runs; without it (even with "Verify JWT" off) some projects still 401 at the gateway,
          // which the browser reports as a generic network error, not as a 401 - indistinguishable from
          // "no internet". Sending it removes that failure mode regardless of the toggle's state.
          Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const offline = new Error('PIN sign-in needs an internet connection. Please try again when you are online.');
      offline.offline = true;
      throw offline;
    }
    const payload = await res.json().catch(() => ({}));

    // Admins, owners and managers must use their password
    if (payload.error === 'use_password') {
      const e = new Error(payload.message || 'This is an admin account. Please sign in with your password.');
      e.code = 'use_password';
      throw e;
    }
    if (payload.error === 'ambiguous' || payload.error === 'locked') {
      throw new Error(payload.message || 'Please try again later.');
    }
    if (res.status === 404) {
      throw new Error('PIN sign-in is not set up on the server yet (the pin-auth function is not deployed).');
    }
    if ((res.status === 401 || res.status === 403) && !payload.error) {
      throw new Error('PIN sign-in is blocked by the server (Verify JWT must be switched off for the pin-auth function).');
    }
    if (!res.ok || !payload.token_hash) throw new Error(payload.error || GENERIC);

    const { error } = await supabase.auth.verifyOtp({ token_hash: payload.token_hash, type: 'magiclink' });
    if (error) throw new Error(GENERIC);

    localStorage.removeItem('qs_pos_operator');
    const state = await this.syncSession();
    if (!state) throw new Error(this.lastRejection || 'Sign-in could not be completed.');
    // this device can now unlock this person offline too
    try { await StaffCache.remember(this.currentProfile, body.pin); } catch (e) { console.warn('[StaffCache]', e); }
    return true;
  },

  async signUp(email, password, fullName, businessName, businessType, phone, country) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          business_name: businessName,
          business_type: businessType,
          phone: phone,
          country: country,
        },
      },
    });
    if (error) throw error;
    return data;
  },

  async verifySignUpOTP(email, token) {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'signup',
    });
    if (error) throw error;
    const state = await this.syncSession();
    if (!state) throw new Error(this.lastRejection || 'Your account is not ready yet. Please sign in again shortly.');
    return data;
  },

  async requestPasswordReset(email) {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
    return data;
  },

  async verifyPasswordResetOTP(email, token) {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'recovery',
    });
    if (error) throw error;
    return data;
  },

  async updatePassword(newPassword) {
    const { data, error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return data;
  },

  async refreshLocalCatalog(shopId) {
    if (!navigator.onLine || !shopId) return;

    try {
      const [prodRes, catRes, custRes, invRes] = await Promise.all([
        supabase.from('products').select('*').eq('shop_id', shopId).eq('is_active', true),
        supabase.from('categories').select('*').or(`shop_id.eq.${shopId},shop_id.is.null`),
        supabase.from('customers').select('*').eq('shop_id', shopId),
        supabase.from('inventory').select('*').eq('shop_id', shopId)
      ]);

      if (invRes.data) {
        await IDB.setInventory(invRes.data);
      }

      if (prodRes.data) {
        const invMap = new Map((invRes.data || []).map((i) => [i.product_id, i.quantity_on_hand]));
        const enrichedProducts = prodRes.data.map((p) => ({
          ...p,
          image_url: p.image_url || null,
          stock_quantity: invMap.has(p.id) ? invMap.get(p.id) : (p.stock_quantity ?? 0)
        }));
        await IDB.setCatalog(enrichedProducts);
      }

      if (catRes.data) await IDB.setCategories(catRes.data);
      if (custRes.data) await IDB.setCustomers(custRes.data);

      localStorage.setItem(CONFIG.STORAGE_KEYS.LAST_SYNC_AT, new Date().toISOString());
    } catch (err) {
      console.warn('[Catalog] Refresh deferred (offline):', err.message);
    }
  },

  // "Lock terminal": the next cashier or staff member unlocks it with their own PIN. The shift stays open (it belongs
  // to the shop), the catalog stays cached and unsynced sales stay queued on the device.
  async signOut() {
    SyncEngine.destroy();
    try {
      await supabase.auth.signOut();
    } catch (e) {
      // Ignore network errors on signout
    }
    this.currentUser = null;
    this.currentProfile = null;
    this.currentShop = null;

    try { await IDB.clearReadCaches(); } catch (e) { /* ignore */ }

    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_USER);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHIFT);
    localStorage.removeItem('qs_pos_operator');
    localStorage.removeItem('qs_pos_locked');

    window.location.reload();
  },
};
