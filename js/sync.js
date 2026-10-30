import { IDB } from './idb.js';
import { supabase } from './auth.js';
import { CONFIG } from './config.js';

export const SyncEngine = {
  isSyncing: false,
  realtimeChannel: null,
  timer: null,
  onStatusChangeCallback: null,

  init(onStatusChange) {
    if (onStatusChange) {
      this.onStatusChangeCallback = onStatusChange;
      this.onStatusChangeCallback(navigator.onLine);
    }

    window.addEventListener('online', async () => {
      if (this.onStatusChangeCallback) this.onStatusChangeCallback(true);
      await this.pullDeltas();
      await this.syncPendingData();
    });

    window.addEventListener('offline', () => {
      if (this.onStatusChangeCallback) this.onStatusChangeCallback(false);
    });

    this.startBackgroundSync();
  },

  getActiveShopId() {
    try {
      const profile = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH_PROFILE) || '{}');
      if (profile && profile.shop_id) return profile.shop_id;
      const directShop = localStorage.getItem(CONFIG.STORAGE_KEYS.ACTIVE_SHOP);
      if (directShop) return directShop;
    } catch {
      // Fall through
    }
    return null;
  },

  startBackgroundSync() {
    const shopId = this.getActiveShopId();
    if (shopId) {
      this.setupRealtimeListeners(shopId);
    }

    if (navigator.onLine) {
      this.pullDeltas();
      this.syncPendingData();
    }

    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (navigator.onLine) {
        this.pullDeltas();
        this.syncPendingData();
      }
    }, CONFIG.SYNC?.POLL_INTERVAL_MS || 30000);
  },

  setupRealtimeListeners(shopId) {
    if (!supabase || !shopId) return;

    if (this.realtimeChannel) {
      supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }

    const channelName = `${CONFIG.SYNC?.CHANNEL_PREFIX || 'qs_shop'}_${shopId}_realtime`;

    this.realtimeChannel = supabase
      .channel(channelName)
      // Products / Catalog
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'products', filter: `shop_id=eq.${shopId}` },
        async (payload) => {
          if (payload.eventType === 'DELETE') {
            await IDB.removeProduct(payload.old.id);
          } else {
            await IDB.upsertProduct(payload.new);
          }
          window.dispatchEvent(new CustomEvent('catalog-updated', { detail: payload }));
        }
      )
      // Categories
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'categories', filter: `shop_id=eq.${shopId}` },
        async (payload) => {
          if (payload.eventType === 'DELETE') {
            await IDB.removeCategory(payload.old.id);
          } else {
            await IDB.upsertCategory(payload.new);
          }
          window.dispatchEvent(new CustomEvent('catalog-updated', { detail: payload }));
        }
      )
      // Inventory updates
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inventory', filter: `shop_id=eq.${shopId}` },
        async (payload) => {
          await IDB.upsertInventory(payload.new);
          window.dispatchEvent(new CustomEvent('inventory-updated', { detail: payload.new }));
        }
      )
      // Customers
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customers', filter: `shop_id=eq.${shopId}` },
        async (payload) => {
          if (payload.eventType === 'DELETE') {
            await IDB.removeCustomer(payload.old.id);
          } else {
            await IDB.upsertCustomer(payload.new);
          }
          window.dispatchEvent(new CustomEvent('customers-updated', { detail: payload }));
        }
      )
      .subscribe((status) => {
        window.dispatchEvent(new CustomEvent('sync-status-changed', { detail: { status } }));
      });
  },

  async pullDeltas() {
    if (!navigator.onLine || this.isSyncing) return;
    const shopId = this.getActiveShopId();
    if (!supabase || !shopId) return;

    try {
      const lastSync = localStorage.getItem(CONFIG.STORAGE_KEYS.LAST_SYNC_AT) || '1970-01-01T00:00:00.000Z';
      const syncStartTime = new Date().toISOString();

      // Delta: Products
      const { data: products } = await supabase
        .from('products')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (products && products.length) {
        await IDB.putBatch('cached_catalog', products);
      }

      // Delta: Categories
      const { data: categories } = await supabase
        .from('categories')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (categories && categories.length) {
        await IDB.putBatch('cached_categories', categories);
      }

      // Delta: Inventory
      const { data: inv } = await supabase
        .from('inventory')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (inv && inv.length) {
        await IDB.putBatch('cached_inventory', inv);
      }

      // Delta: Customers
      const { data: customers } = await supabase
        .from('customers')
        .select('*')
        .eq('shop_id', shopId)
        .gt('updated_at', lastSync);
      if (customers && customers.length) {
        await IDB.putBatch('cached_customers', customers);
      }

      localStorage.setItem(CONFIG.STORAGE_KEYS.LAST_SYNC_AT, syncStartTime);
      window.dispatchEvent(new CustomEvent('catalog-updated', { detail: { delta: true } }));
    } catch (err) {
      console.warn('[Sync] Delta pull exception:', err);
    }
  },

  async syncPendingData() {
    if (!navigator.onLine || this.isSyncing) return;
    this.isSyncing = true;
    window.dispatchEvent(new CustomEvent('sync-started'));

    try {
      // 1. Process Outbox Queue (Mutations made while offline)
      const outbox = await IDB.getOutbox();
      for (const item of outbox) {
        try {
          // Customers
          if (item.type === 'CREATE_CUSTOMER' || item.type === 'UPDATE_CUSTOMER') {
            const { error: err } = await supabase.from('customers').upsert([item.payload], { onConflict: 'id' });
            if (err) throw err;
          } else if (item.type === 'DELETE_CUSTOMER') {
            const { error: err } = await supabase.from('customers').delete().eq('id', item.payload.id);
            if (err) throw err;
          }
          // Products
          else if (item.type === 'CREATE_PRODUCT' || item.type === 'UPDATE_PRODUCT') {
            const { error: err } = await supabase.from('products').upsert([item.payload], { onConflict: 'id' });
            if (err) throw err;
          } else if (item.type === 'DELETE_PRODUCT') {
            const { error: err } = await supabase.from('products').delete().eq('id', item.payload.id);
            if (err) throw err;
          }
          // Categories
          else if (item.type === 'CREATE_CATEGORY' || item.type === 'UPDATE_CATEGORY') {
            const { error: err } = await supabase.from('categories').upsert([item.payload], { onConflict: 'id' });
            if (err) throw err;
          } else if (item.type === 'DELETE_CATEGORY') {
            const { error: err } = await supabase.from('categories').delete().eq('id', item.payload.id);
            if (err) throw err;
          }
          // Offline Sale Orders
          else if (item.type === 'SALE_ORDER') {
            const { error: saleErr } = await supabase.rpc('process_pos_sale', {
              p_order: item.payload.order,
              p_items: item.payload.items,
              p_payments: item.payload.payments
            });
            if (saleErr) throw saleErr;
          }

          // Successfully synchronized online -> remove from outbox
          await IDB.removeOutboxItem(item.id);
        } catch (err) {
          console.warn(`[Sync] Outbox item ${item.id} (${item.type}) error:`, err);
          break; // Stop outbox processing to maintain transaction order
        }
      }

      // 2. Process Pending Offline Orders
      const pending = await IDB.getPendingOrders();
      for (const order of pending) {
        const orderPayload = {
          id: order.id,
          shop_id: order.shop_id,
          cashier_id: order.cashier_id,
          customer_id: order.customer_id,
          shift_id: order.shift_id || null,
          receipt_no: order.receipt_no,
          subtotal: order.subtotal,
          discount_amount: order.discount_amount || 0,
          tax_amount: order.tax_amount || 0,
          total: order.total,
          order_status: order.order_status || 'completed',
          service_type: order.service_type || 'walk_in',
          synced_from_offline: true,
          offline_created_at: order.offline_created_at || order.created_at,
          created_at: order.created_at || new Date().toISOString()
        };

        const itemsPayload = (order.items || []).map((item) => ({
          id: item.id || crypto.randomUUID(),
          order_id: order.id,
          product_id: item.product_id,
          product_name: item.product_name,
          unit_price: item.unit_price,
          cost_price: item.cost_price || 0,
          quantity: item.quantity,
          tax_rate: item.tax_rate || 0,
          discount_amount: item.discount_amount || 0,
          total: item.total
        }));

        const paymentsPayload = (order.payments || []).map((pay) => ({
          id: pay.id || crypto.randomUUID(),
          order_id: order.id,
          amount: pay.amount,
          payment_method: pay.payment_method || 'cash',
          reference_no: pay.reference_no || null,
          reference_code: pay.reference_code || pay.reference_no || null,
          created_at: pay.created_at || order.created_at || new Date().toISOString()
        }));

        let pushSuccess = false;
        try {
          const { error: rpcErr } = await supabase.rpc('process_pos_sale', {
            p_order: orderPayload,
            p_items: itemsPayload,
            p_payments: paymentsPayload
          });

          if (!rpcErr) {
            pushSuccess = true;
          } else {
            console.warn('[Sync] RPC failed, falling back to direct table inserts:', rpcErr.message);
          }
        } catch (rpcEx) {
          console.warn('[Sync] RPC exception, falling back to direct tables:', rpcEx);
        }

        if (!pushSuccess) {
          const { error: orderErr } = await supabase.from('orders').upsert([orderPayload]);
          if (orderErr) {
            console.warn('[Sync] Order push error:', orderErr.message);
            continue;
          }

          if (itemsPayload.length) {
            await supabase.from('order_items').upsert(itemsPayload);
          }

          if (paymentsPayload.length) {
            await supabase.from('payments').upsert(paymentsPayload);
          }
        }

        await IDB.removeOfflineOrder(order.id);
        await IDB.saveReceipt(order);
      }

      window.dispatchEvent(new CustomEvent('sync-completed', { detail: { success: true } }));
    } catch (e) {
      console.warn('[Sync] Background sync exception:', e);
      window.dispatchEvent(new CustomEvent('sync-completed', { detail: { success: false, error: e } }));
    } finally {
      this.isSyncing = false;
    }
  },

  destroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.realtimeChannel && supabase) {
      supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }
};
