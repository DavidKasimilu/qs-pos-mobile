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

  async syncSession() {
    try {
      if (navigator.onLine) {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session?.user) {
          return this.restoreCachedSession();
        }

        this.currentUser = session.user;

        // 1. Fetch user profile and assigned shop details
        const { data: profile } = await supabase
          .from('profiles')
          .select('*, shops(*)')
          .eq('id', this.currentUser.id)
          .maybeSingle();

        if (profile) {
          this.currentProfile = profile;
          this.currentShop = profile.shops;
        } else {
          const { data: fallbackShop } = await supabase.from('shops').select('*').limit(1).maybeSingle();
          this.currentShop = fallbackShop;
        }

        // Cache session identity locally for offline POS operation
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_USER, JSON.stringify(this.currentUser));
        if (this.currentProfile) {
          localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE, JSON.stringify(this.currentProfile));
        }
        if (this.currentShop) {
          localStorage.setItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP, this.currentShop.id);
        }

        // 2. Refresh local IndexedDB catalog with current shop products
        if (this.currentShop?.id) {
          await this.refreshLocalCatalog(this.currentShop.id);
          SyncEngine.startBackgroundSync();
        }

        return { user: this.currentUser, profile: this.currentProfile, shop: this.currentShop };
      } else {
        return this.restoreCachedSession();
      }
    } catch (err) {
      console.warn('[Auth] Offline cached session fallback:', err);
      return this.restoreCachedSession();
    }
  },

  restoreCachedSession() {
    try {
      const cachedUser = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_USER) || 'null');
      const cachedProfile = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE) || 'null');

      if (cachedProfile) {
        this.currentUser = cachedUser;
        this.currentProfile = cachedProfile;
        this.currentShop = cachedProfile.shops || {
          id: localStorage.getItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP),
          name: cachedProfile.full_name ? `${cachedProfile.full_name}'s Shop` : 'QuickSell Terminal',
          currency: 'KES'
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
    await this.syncSession();
    return data;
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
    await this.syncSession();
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
        // Map current inventory stock onto products
        const invMap = new Map((invRes.data || []).map((i) => [i.product_id, i.quantity_on_hand]));
        const enrichedProducts = prodRes.data.map((p) => ({
          ...p,
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

    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_USER);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHIFT);

    window.location.reload();
  },
};