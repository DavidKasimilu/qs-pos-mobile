// Clean base URL without trailing slash to prevent double-slash API routing issues
const RAW_GATEWAY_URL = 'https://quicksell-gateway.davidkasimilu.workers.dev';
const CLEAN_GATEWAY_URL = RAW_GATEWAY_URL.replace(/\/+$/, '');

export const CONFIG = {
  // Cloudflare Worker gateway proxying to Supabase
  GATEWAY_URL: CLEAN_GATEWAY_URL,

  // Fallback public anon key for direct worker auth headers
  SUPABASE_ANON_KEY: 'sb_publishable_wc82l8uhVqffrUhY3-XTng_GtISnSLx',

  // Link to the Backoffice Web Portal on GitHub Pages
  BACKOFFICE_URL: 'https://davidkasimilu.github.io/QuickSellPOS/',

  // Hardware profile & terminal identity metadata
  DEVICE_NAME: 'Android Mobile POS',
  APP_VERSION: '1.114.9',
  PLATFORM: 'mobile_pwa',
  HEARTBEAT_INTERVAL_MS: 45000, // 45 seconds

  // Storage and database keys
  STORAGE_KEYS: {
    DEVICE_FINGERPRINT: 'qs_pos_device_fingerprint',
    ACTIVE_CART: 'qs_pos_active_cart',
    AUTH_TOKEN: 'qs_pos_auth_token',
  },
};
