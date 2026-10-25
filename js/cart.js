// js/cart.js
import { idb } from './idb.js';
import { auth } from './auth.js';
import { syncEngine } from './sync.js';
import { getSupabase } from './config.js';

class CartManager {
  constructor() {
    this.items = [];
    this.selectedCustomer = null;
    this.discount = 0;
  }

  addItem(product, qty = 1) {
    const existing = this.items.find((i) => i.product.id === product.id);
    if (existing) {
      existing.quantity += qty;
    } else {
      this.items.push({ product, quantity: qty });
    }
    this.notify();
  }

  updateQuantity(productId, qty) {
    if (qty <= 0) {
      this.items = this.items.filter((i) => i.product.id !== productId);
    } else {
      const item = this.items.find((i) => i.product.id === productId);
      if (item) item.quantity = qty;
    }
    this.notify();
  }

  setCustomer(customer) {
    this.selectedCustomer = customer;
    this.notify();
  }

  clear() {
    this.items = [];
    this.selectedCustomer = null;
    this.discount = 0;
    this.notify();
  }

  getTotals() {
    let subtotal = 0;
    let taxTotal = 0;

    this.items.forEach(({ product, quantity }) => {
      const lineSubtotal = (parseFloat(product.retail_price) || 0) * quantity;
      const taxRate = parseFloat(product.tax_rate) || 0;
      const lineTax = (lineSubtotal * taxRate) / 100;

      subtotal += lineSubtotal;
      taxTotal += lineTax;
    });

    const total = Math.max(0, subtotal + taxTotal - this.discount);
    return { subtotal, taxTotal, discount: this.discount, total };
  }

  notify() {
    window.dispatchEvent(new CustomEvent('cart-updated', {
      detail: { items: this.items, totals: this.getTotals(), customer: this.selectedCustomer }
    }));
  }

  async checkout(paymentMethod = 'cash', referenceNo = '') {
    if (!this.items.length) throw new Error('Cart is empty');

    const currentUser = auth.getCurrentUser();
    if (!currentUser || !currentUser.shop_id) {
      throw new Error('Cashier profile or Shop ID missing');
    }

    const totals = this.getTotals();
    const orderId = crypto.randomUUID();
    const receiptNo = `REC-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const nowIso = new Date().toISOString();

    // 1. Build Orders Record
    const orderRecord = {
      id: orderId,
      receipt_no: receiptNo,
      shop_id: currentUser.shop_id,
      cashier_id: currentUser.id,
      customer_id: this.selectedCustomer ? this.selectedCustomer.id : null,
      shift_id: null, // Hook into active shift if open
      subtotal: totals.subtotal,
      discount_amount: totals.discount,
      tax_amount: totals.taxTotal,
      total: totals.total,
      order_status: 'completed',
      service_type: 'walk_in',
      synced_from_offline: !navigator.onLine,
      offline_created_at: !navigator.onLine ? nowIso : null,
      created_at: nowIso
    };

    // 2. Build Order Items
    const itemsRecord = this.items.map(({ product, quantity }) => {
      const unitPrice = parseFloat(product.retail_price) || 0;
      const lineTotal = unitPrice * quantity;
      return {
        id: crypto.randomUUID(),
        order_id: orderId,
        product_id: product.id,
        product_name: product.name,
        unit_price: unitPrice,
        cost_price: parseFloat(product.cost_price) || 0,
        quantity: quantity,
        tax_rate: parseFloat(product.tax_rate) || 0,
        discount_amount: 0,
        total: lineTotal
      };
    });

    // 3. Build Payment
    const paymentRecord = [{
      id: crypto.randomUUID(),
      order_id: orderId,
      amount: totals.total,
      payment_method: paymentMethod,
      reference_no: referenceNo || null,
      reference_code: referenceNo || null,
      created_at: nowIso
    }];

    // 4. Update Local Stock immediately for offline responsiveness
    for (const line of itemsRecord) {
      await idb.decrementInventoryStock(line.product_id, line.quantity);
    }

    // 5. Save Order locally in IDB
    await idb.put('orders', orderRecord);
    await idb.putBatch('order_items', itemsRecord);
    await idb.putBatch('payments', paymentRecord);

    // 6. Online Push or Buffer to Outbox
    const payload = { order: orderRecord, items: itemsRecord, payments: paymentRecord };
    const supabase = getSupabase();

    if (navigator.onLine && supabase) {
      try {
        const { error } = await supabase.rpc('process_pos_sale', {
          p_order: orderRecord,
          p_items: itemsRecord,
          p_payments: paymentRecord
        });
        if (error) throw error;
      } catch (err) {
        console.warn('RPC online execution failed, queuing to outbox:', err);
        await idb.put('outbox', {
          id: crypto.randomUUID(),
          type: 'SALE_ORDER',
          payload,
          created_at: nowIso
        });
      }
    } else {
      await idb.put('outbox', {
        id: crypto.randomUUID(),
        type: 'SALE_ORDER',
        payload,
        created_at: nowIso
      });
    }

    this.clear();
    return { success: true, orderId, receiptNo };
  }
}

export const cart = new CartManager();