import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { CONFIG } from './config.js';
import { IDB } from './idb.js';

// Initialize Supabase through the Cloudflare Worker Edge Proxy
export const supabase = createClient(CONFIG.GATEWAY_URL, 'public-anon-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export const Auth = {
  currentUser: null,
  currentProfile: null,
  currentShop: null,

  async syncSession() {
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error || !session?.user) {
        return null;
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
        // Fallback for new admin signups
        const { data: fallbackShop } = await supabase.from('shops').select('*').limit(1).maybeSingle();
        this.currentShop = fallbackShop;
      }

      // 2. Refresh local IndexedDB catalog with current shop products
      if (this.currentShop?.id) {
        await this.refreshLocalCatalog(this.currentShop.id);
      }

      return { user: this.currentUser, profile: this.currentProfile, shop: this.currentShop };
    } catch (err) {
      console.warn('Using offline cached session data:', err);
      return null;
    }
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
      const [prodRes, catRes, custRes] = await Promise.all([
        supabase.from('products').select('*').eq('shop_id', shopId).eq('is_active', true),
        supabase.from('categories').select('*'),
        supabase.from('customers').select('*').eq('shop_id', shopId),
      ]);

      if (prodRes.data) await IDB.setCatalog(prodRes.data);
      if (catRes.data) await IDB.setCategories(catRes.data);
      if (custRes.data) await IDB.setCustomers(custRes.data);
    } catch (err) {
      console.warn('Catalog refresh deferred (offline):', err.message);
    }
  },

  async signOut() {
    await supabase.auth.signOut();
    this.currentUser = null;
    this.currentProfile = null;
    this.currentShop = null;
    window.location.reload();
  },
};
        
