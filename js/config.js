// js/config.js
export const CONFIG = {
  // Replace these with your actual Supabase project credentials
  SUPABASE_URL: window.SUPABASE_URL || 'https://YOUR_SUPABASE_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: window.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY',

  STORAGE_KEYS: {
    AUTH_USER: 'qs_auth_user',
    AUTH_PROFILE: 'qs_auth_profile',
    ACTIVE_SHOP: 'qs_active_shop',
    ACTIVE_SHIFT: 'qs_active_shift',
    LAST_SYNC_AT: 'qs_last_sync_timestamp'
  },

  SYNC: {
    POLL_INTERVAL_MS: 30000, // Background sync fallback every 30s
    CHANNEL_NAME: 'pos-realtime-sync',
    BATCH_SIZE: 50
  }
};

// Initialize Supabase instance onto window if CDN script is loaded
if (window.supabase && !window.supabaseClient) {
  window.supabaseClient = window.supabase.createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true
      },
      realtime: {
        params: {
          eventsPerSecond: 10
        }
      }
    }
  );
}

export const getSupabase = () => window.supabaseClient;