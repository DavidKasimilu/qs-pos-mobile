export const CONFIG = {
  // Direct Supabase Project Endpoint
  SUPABASE_URL: 'https://nceblfeenegfzebeiivx.supabase.co',
  
  // Public Anon / Publishable Key
  SUPABASE_ANON_KEY: 'sb_publishable_wc82l8uhVqffrUhY3-XTng_GtISnSLx',

  // Link to the Backoffice Web Portal on GitHub Pages
  BACKOFFICE_URL: 'https://davidkasimilu.github.io/QuickSellPOS/',

  // Hardware profile & terminal identity metadata
  DEVICE_NAME: 'Android Mobile POS',
  APP_VERSION: '1.114.9',
  PLATFORM: 'mobile_pwa',
  HEARTBEAT_INTERVAL_MS: 45000,

  STORAGE_KEYS: {
    DEVICE_FINGERPRINT: 'qs_pos_device_fingerprint',
    ACTIVE_CART: 'qs_pos_active_cart',
    AUTH_TOKEN: 'qs_pos_auth_token',
    AUTH_USER: 'qs_pos_auth_user',
    AUTH_PROFILE: 'qs_pos_auth_profile',
    ACTIVE_SHOP: 'qs_pos_active_shop',
    ACTIVE_SHIFT: 'qs_pos_active_shift',
    LAST_SYNC_AT: 'qs_pos_last_sync_timestamp'
  },

  SYNC: {
    POLL_INTERVAL_MS: 30000,
    CHANNEL_PREFIX: 'qs_shop',
    BATCH_SIZE: 50
  }
};

// Singleton Supabase client instantiation
if (typeof window !== 'undefined' && window.supabase && !window.supabaseClient) {
  window.supabaseClient = window.supabase.createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      },
      realtime: {
        params: {
          eventsPerSecond: 10
        }
      }
    }
  );
}

export const getSupabase = () => {
  if (typeof window !== 'undefined' && window.supabaseClient) {
    return window.supabaseClient;
  }
  if (typeof window !== 'undefined' && window.supabase) {
    window.supabaseClient = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
    return window.supabaseClient;
  }
  return null;
};