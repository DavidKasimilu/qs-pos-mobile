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
  },
};
