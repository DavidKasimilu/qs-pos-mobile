// js/sync.js
import { CONFIG, getSupabase } from './config.js';
import { idb } from './idb.js';

class SyncEngine {
  constructor() {
    this.isSyncing = false;
    this.realtimeChannel = null;
    this.timer = null;
  }

  getActiveShopId() {
    try {
      const profile = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE) || '{}');
      return profile.shop_id || null;
    } catch {
      return null;
    }
  }

  async start() {
    const shopId = this.getActiveShopId();
    if (!shopId) return;

    // 1. Initial Delta Pull & Outbox Flush
    await this.pullDeltas();
    await this.flushOutbox();

    // 2. Setup Supabase Realtime Channel
    this.setupRealtimeListeners(shopId);

    // 3. Fallback Interval
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (navigator.onLine) {
        this.pullDeltas();
        this.flushOutbox();
      }
    }, CONFIG.SYNC.POLL_INTERVAL_MS);
  }

  setupRealtimeListeners(shopId) {
    const supabase = getSupabase();
    if (!supabase) return;

    if (this.realtimeChannel) {
      supabase.removeChannel(this.realtimeChannel);
    }

    this.realtimeChannel = supabase
      .channel(`shop_${shopId}_sync`)
      // Products
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products', filter: `shop_id=eq.${shopId}` }, async (payload) => {
        if (payload.eventType === 'DELETE') {
          await idb.delete('products', payload.old.id);
        } else {
          await idb.put('products', payload.new);
        }
        window.dispatchEvent(new CustomEvent('catalog-updated', { detail: { table: 'products' } }));
      })
      // Categories
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories', filter: `shop_id=eq.${shopId}` }, async (payload) => {
        if (payload.eventType === 'DELETE') {
          await idb.delete('categories', payload.old.id);
        } else {
          await idb.put('categories', payload.new);
        }
        window.dispatchEvent(new CustomEvent('catalog-updated', { detail: { table: 'categories' } }));
      })
      // Inventory
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory', filter: `shop_id=eq.${shopId}` }, async (payload) => {
        await idb.put('inventory', payload.new);
        window.dispatchEvent(new CustomEvent('inventory-updated', { detail: payload.new }));
      })
      // Customers
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers', filter: `shop_id=eq.${shopId}` }, async (payload) => {
        await idb.put('customers', payload.new);
        window.dispatchEvent(new CustomEvent('customers-updated', { detail: payload.new }));
      })
      .subscribe((status) => {
        window.dispatchEvent(new CustomEvent('sync-status-changed', { detail: { status } }));
      });
  }

  async pullDeltas() {
    if (!navigator.onLine || this.isSyncing) return;
    const supabase = getSupabase();
    const shopId = this.getActiveShopId();
    if (!supabase || !shopId) return;

    this.isSyncing = true;
    window.dispatchEvent(new CustomEvent('sync-started'));

    try {
      const lastSync = localStorage.getItem(CONFIG.STORAGE_KEYS.LAST_SYNC_AT) || '1970-01-01T00:00:00.000Z';
      const syncStartTime = new Date().toISOString();

      // Delta: Products
      const { data: products } = await supabase
        .from('products')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (products?.length) await idb.putBatch('products', products);

      // Delta: Categories
      const { data: categories } = await supabase
        .from('categories')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (categories?.length) await idb.putBatch('categories', categories);

      // Delta: Inventory
      const { data: inv } = await supabase
        .from('inventory')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (inv?.length) await idb.putBatch('inventory', inv);

      // Delta: Customers
      const { data: customers } = await supabase
        .from('customers')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (customers?.length) await idb.putBatch('customers', customers);

      localStorage.setItem(CONFIG.STORAGE_KEYS.LAST_SYNC_AT, syncStartTime);
      window.dispatchEvent(new CustomEvent('sync-completed', { detail: { success: true } }));
    } catch (err) {
      console.error('Error during delta sync:', err);
      window.dispatchEvent(new CustomEvent('sync-completed', { detail: { success: false, error: err } }));
    } finally {
      this.isSyncing = false;
    }
  }

  async flushOutbox() {
    if (!navigator.onLine) return;
    const supabase = getSupabase();
    if (!supabase) return;

    const queue = await idb.getAll('outbox');
    if (!queue || !queue.length) return;

    for (const item of queue) {
      try {
        if (item.type === 'SALE_ORDER') {
          const { data, error } = await supabase.rpc('process_pos_sale', {
            p_order: item.payload.order,
            p_items: item.payload.items,
            p_payments: item.payload.payments
          });

          if (error) throw error;
          await idb.delete('outbox', item.id);
        } else if (item.type === 'CREATE_CUSTOMER') {
          const { error } = await supabase
            .from('customers')
            .upsert(item.payload, { onConflict: 'id' });

          if (error) throw error;
          await idb.delete('outbox', item.id);
        }
      } catch (err) {
        console.error(`Failed to flush outbox item ${item.id}:`, err);
        // Break queue on error to maintain sequential execution
        break;
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    const supabase = getSupabase();
    if (this.realtimeChannel && supabase) {
      supabase.removeChannel(this.realtimeChannel);
    }
  }
}

export const syncEngine = new SyncEngine();