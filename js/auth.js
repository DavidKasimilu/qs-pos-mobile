import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { CONFIG } from './config.js';
import { IDB } from './idb.js';
import { SyncEngine } from './sync.js';

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

        // A different person on this device: wipe the previous user's cached company data first
        const cacheOwner = localStorage.getItem('qs_pos_cache_owner');
        if (cacheOwner && cacheOwner !== session.user.id) {
          await IDB.clearReadCaches();
          localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP);
          localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHIFT);
          localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_CART);
        }
        localStorage.setItem('qs_pos_cache_owner', session.user.id);

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

        return { user: this.currentUser, profile: this.currentProfile, shop: this.currentShop };
      }
    } catch (e) {
      console.warn('[Auth] Error restoring offline session:', e);
    }
    return null;
  },

  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const state = await this.syncSession();
    if (!state) throw new Error(this.lastRejection || 'Sign-in could not be completed.');
    return data;
  },

  // Email + 4-digit PIN. The server checks the PIN (hashed, lockouts, throttling) and returns a one-time
  // token that is exchanged for a normal session, so row-level security applies exactly as with a password.
  async signInWithPin(email, pin) {
    const GENERIC = 'Invalid email or PIN, or too many attempts. Please try again later.';
    let res;
    try {
      res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/pin-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY },
        body: JSON.stringify({ action: 'login', email, pin }),
      });
    } catch (e) {
      throw new Error('PIN sign-in needs an internet connection. Use your password, or try again when online.');
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.token_hash) throw new Error(payload.error || GENERIC);

    const { error } = await supabase.auth.verifyOtp({ token_hash: payload.token_hash, type: 'magiclink' });
    if (error) throw new Error(GENERIC);

    const state = await this.syncSession();
    if (!state) throw new Error(this.lastRejection || 'Sign-in could not be completed.');
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

    window.location.reload();
  },
};
