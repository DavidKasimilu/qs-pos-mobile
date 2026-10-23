import { supabase } from './auth.js';

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
  },

  addItem(product, quantity = 1, customPrice = null, discountVal = 0, discountType = 'pct', remark = '') {
    const unitPrice = customPrice !== null ? parseFloat(customPrice) : parseFloat(product.retail_price || 0);
    const qty = parseFloat(quantity) || 1;

    let discountAmount = 0;
    if (discountType === 'pct') {
      discountAmount = (unitPrice * qty) * (parseFloat(discountVal) / 100);
    } else {
      discountAmount = parseFloat(discountVal) || 0;
    }

    const lineTotal = Math.max(0, (unitPrice * qty) - discountAmount);

    const existingIndex = this.items.findIndex(
      (i) => i.id === product.id && i.unitPrice === unitPrice && i.remark === remark
    );

    if (existingIndex > -1) {
      this.items[existingIndex].quantity += qty;
      this.items[existingIndex].total = Math.max(
        0,
        (this.items[existingIndex].quantity * unitPrice) - this.items[existingIndex].discountAmount
      );
    } else {
      this.items.push({
        id: product.id,
        name: product.name,
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

  clearTicket(audit = true) {
    if (!this.items.length) return;

    if (audit && this.activeShopId) {
      this.items.forEach((item) => {
        if (navigator.onLine && supabase) {
          supabase.from('cart_discard_logs').insert([{
            shop_id: this.activeShopId,
            product_id: item.id,
            product_name: item.name,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            reason: 'Mobile terminal ticket cleared',
          }]).then();
        }
      });
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
  },
};
                         
