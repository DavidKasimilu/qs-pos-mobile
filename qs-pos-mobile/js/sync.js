import { IDB } from './idb.js';
import { supabase } from './auth.js';

export const SyncEngine = {
  isSyncing: false,

  init(onStatusChange) {
    window.addEventListener('online', () => {
      onStatusChange(true);
      this.syncPendingData();
    });
    window.addEventListener('offline', () => onStatusChange(false));
  },

  async syncPendingData() {
    if (!navigator.onLine || this.isSyncing) return;
    this.isSyncing = true;

    try {
      const pending = await IDB.getPendingOrders();
      for (const order of pending) {
        // 1. Post to 'orders'
        const { error: orderErr } = await supabase.from('orders').insert([{
          id: order.id,
          shop_id: order.shop_id,
          cashier_id: order.cashier_id,
          receipt_no: order.receipt_no,
          subtotal: order.subtotal,
          discount_amount: order.discount_amount,
          tax_amount: order.tax_amount,
          total: order.total,
          order_status: 'completed',
          synced_from_offline: true,
          created_at: order.created_at
        }]);

        if (!orderErr) {
          // 2. Post child line items
          await supabase.from('order_items').insert(order.items);
          // 3. Post payment
          await supabase.from('payments').insert(order.payments);
          // 4. Remove from offline queue
          await IDB.removeOfflineOrder(order.id);
        }
      }
    } catch (e) {
      console.warn('Sync attempt failed:', e);
    } finally {
      this.isSyncing = false;
    }
  }
};