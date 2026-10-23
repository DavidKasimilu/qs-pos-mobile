import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { CONFIG } from './config.js';
import { IDB } from './idb.js';

// Initialize Supabase Client through the Cloudflare Worker Gateway
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

  // 1. Session Synchronizer (Runs on Boot)
  async syncSession() {
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error || !session?.user) {
        return null;
      }

      this.currentUser = session.user;

      // Fetch profile & assigned shop context
      const { data: profile } = await supabase
        .from('profiles')
        .select('*, shops(*)')
        .eq('id', this.currentUser.id)
        .maybeSingle();

      if (profile) {
        this.currentProfile = profile;
        this.currentShop = profile.shops;

        // Cache catalog locally to IndexedDB for offline operation
        this.refreshLocalCatalog(profile.shop_id);
      }

      return { user: this.currentUser, profile: this.currentProfile, shop: this.currentShop };
    } catch (err) {
      console.warn('Session sync offline fallback:', err);
      return null;
    }
  },

  // 2. Sign In With Credentials
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    await this.syncSession();
    return data;
  },

  // 3. Register New Account (Includes Business Details & Provisions Shop)
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

  // 4. Verify 8-Digit OTP Code
  async verifyOTP(email, token) {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'signup',
    });
    if (error) throw error;
    await this.syncSession();
    return data;
  },

  // 5. Download Fresh Catalog into IndexedDB
  async refreshLocalCatalog(shopId) {
    if (!navigator.onLine || !shopId) return;

    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('shop_id', shopId)
      .eq('is_active', true);

    if (products && products.length) {
      await IDB.setCatalog(products);
    }
  },

  // 6. Sign Out
  async signOut() {
    await supabase.auth.signOut();
    this.currentUser = null;
    this.currentProfile = null;
    this.currentShop = null;
    window.location.reload();
  },
};