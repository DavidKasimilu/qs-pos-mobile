// js/auth.js
import { CONFIG, getSupabase } from './config.js';
import { syncEngine } from './sync.js';

export const auth = {
  async login(email, password) {
    const supabase = getSupabase();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (authError) throw authError;

    // Fetch user profile and associated shop
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, shop_id, is_active')
      .eq('id', authData.user.id)
      .single();

    if (profileError || !profile) {
      await supabase.auth.signOut();
      throw new Error('User profile could not be loaded');
    }

    if (!profile.is_active) {
      await supabase.auth.signOut();
      throw new Error('This cashier account is inactive');
    }

    // Persist profile to localStorage for offline POS access
    localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_USER, JSON.stringify(authData.user));
    localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE, JSON.stringify(profile));

    // Start background sync and realtime channels
    syncEngine.start();

    return { user: authData.user, profile };
  },

  async logout() {
    syncEngine.stop();
    const supabase = getSupabase();
    if (supabase) {
      await supabase.auth.signOut().catch(() => {});
    }
    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_USER);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE);
    localStorage.removeItem(CONFIG.STORAGE_KEYS.ACTIVE_SHIFT);
    window.location.reload();
  },

  getCurrentUser() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE) || 'null');
    } catch {
      return null;
    }
  },

  isAuthenticated() {
    return !!this.getCurrentUser();
  }
};