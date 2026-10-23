import { IDB } from './idb.js';
import { supabase } from './auth.js';

export const SyncEngine = {
  isSyncing: false,

  init(onStatusChange) {
    window.addEventListener('online', () => {
      if (onStatusChange) onStatusChange(true);
      this.syncPendingData();
    });
    window.addEventListener('offline', () => {
      if (onStatusChange) onStatusChange(false);
    });
  },

  async syncPendingData() {
    if (!navigator.onLine || this.isSyncing) return;
    this.isSyncing = true;

    try {
      const pending = await IDB.getPendingOrders();
      for (const order of pending) {
        // 1. Insert parent order record
        const { error: orderErr } = await supabase.from('orders').upsert([{
          id: order.id,
          shop_id: order.shop_id,
          cashier_id: order.cashier_id,
          customer_id: order.customer_id,
          receipt_no: order.receipt_no,
          subtotal: order.subtotal,
          discount_amount: order.discount_amount,
          tax_amount: order.tax_amount,
          total: order.total,
          order_status: 'completed',
          synced_from_offline: true,
          created_at: order.created_at,
        }]);

        if (orderErr) {
          console.warn('[Sync] Order push error:', orderErr.message);
          continue;
        }

        // 2. Insert line items
        if (order.items && order.items.length) {
          await supabase.from('order_items').upsert(order.items);
        }

        // 3. Insert payment record
        if (order.payments && order.payments.length) {
          await supabase.from('payments').upsert(order.payments);
        }

        // 4. Remove from offline queue
        await IDB.removeOfflineOrder(order.id);
      }
    } catch (e) {
      console.warn('[Sync] Background sync exception:', e);
    } finally {
      this.isSyncing = false;
    }
  },
};
