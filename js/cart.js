import { supabase } from './auth.js';
import { IDB } from './idb.js';

export const Cart = {
  items: [],
  selectedCustomer: null,
  ticketDiscount: 0,
  activeShopId: null,

  init(shopId) {
    this.activeShopId = shopId;
    this.items = [];
    this.selectedCustomer = null;
    this.ticketDiscount = 0;
    this.notifyUpdate();
  },

  addItem(product, quantity = 1, customPrice = null, discountVal = 0, discountType = 'pct', remark = '') {
    // Resolve price gracefully across schema variations
    const rawPrice = customPrice !== null && customPrice !== undefined && customPrice !== '' 
      ? customPrice 
      : (product.retail_price ?? product.price ?? 0);
    const unitPrice = Math.max(0, parseFloat(rawPrice) || 0);
    const qty = Math.max(0.01, parseFloat(quantity) || 1);

    // Calculate line item discount
    let discountAmount = 0;
    if (discountType === 'pct') {
      discountAmount = (unitPrice * qty) * (Math.min(100, Math.max(0, parseFloat(discountVal) || 0)) / 100);
    } else {
      discountAmount = Math.min(unitPrice * qty, Math.max(0, parseFloat(discountVal) || 0));
    }

    const lineTotal = Math.max(0, (unitPrice * qty) - discountAmount);

    const existingIndex = this.items.findIndex(
      (i) => i.id === product.id && i.unitPrice === unitPrice && i.remark === remark
    );

    if (existingIndex > -1) {
      this.items[existingIndex].quantity += qty;
      this.items[existingIndex].discountAmount += discountAmount;
      this.items[existingIndex].total = Math.max(
        0,
        (this.items[existingIndex].quantity * unitPrice) - this.items[existingIndex].discountAmount
      );
    } else {
      this.items.push({
        id: product.id,
        name: product.name || 'Unnamed Item',
        quantity: qty,
        unitPrice: unitPrice,
        costPrice: parseFloat(product.cost_price || 0),
        taxRate: parseFloat(product.tax_rate || 0),
        discountAmount: discountAmount,
        total: lineTotal,
        remark: remark,
      });
    }

    this.notifyUpdate();
  },

  setTicketDiscount(amount) {
    this.ticketDiscount = Math.max(0, parseFloat(amount) || 0);
    this.notifyUpdate();
  },

  async clearTicket(audit = true) {
    if (!this.items.length) return;

    if (audit && this.activeShopId) {
      const logs = this.items.map((item) => ({
        id: crypto.randomUUID(),
        shop_id: this.activeShopId,
        product_id: item.id,
        product_name: item.name,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        reason: 'Mobile terminal ticket cleared by user',
        created_at: new Date().toISOString()
      }));

      try {
        if (navigator.onLine && supabase) {
          const { error } = await supabase.from('cart_discard_logs').insert(logs);
          if (error) throw error;
        } else {
          for (const log of logs) {
            await IDB.queueOutbox('CART_DISCARD', log);
          }
        }
      } catch (err) {
        console.warn('[Cart] Online discard logging failed, queued locally:', err);
        for (const log of logs) {
          await IDB.queueOutbox('CART_DISCARD', log);
        }
      }
    }

    this.items = [];
    this.selectedCustomer = null;
    this.ticketDiscount = 0;
    this.notifyUpdate();
  },

  getTotals() {
    let subtotal = 0;
    let totalLineDiscount = 0;
    let taxAmount = 0;

    this.items.forEach((item) => {
      subtotal += item.unitPrice * item.quantity;
      totalLineDiscount += item.discountAmount;
      taxAmount += item.total * (item.taxRate / 100);
    });

    const grandTotal = Math.max(0, subtotal - totalLineDiscount - this.ticketDiscount + taxAmount);

    return {
      subtotal,
      discountAmount: totalLineDiscount + this.ticketDiscount,
      taxAmount,
      grandTotal,
      itemCount: this.items.reduce((acc, curr) => acc + curr.quantity, 0),
    };
  },

  notifyUpdate() {
    const totals = this.getTotals();
    const chargeLabel = document.getElementById('lbl-charge-amount');
    if (chargeLabel) {
      chargeLabel.textContent = totals.grandTotal.toFixed(2);
    }

    window.dispatchEvent(new CustomEvent('cart-updated', {
      detail: {
        items: this.items,
        totals,
        customer: this.selectedCustomer
      }
    }));
  },
};