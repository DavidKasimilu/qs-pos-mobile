// Receipt printing through the phone's print dialog (works with Android print services such as RawBT
// or a paired thermal printer). Layout is sized for 58mm or 80mm paper.
import { Auth } from './auth.js';
import { Currency } from './currency.js';
import { Prefs } from './prefs.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const METHODS = { cash: 'Cash', mpesa: 'M-PESA', card: 'Card' };

export function buildReceiptHtml(order, items, payments, paperWidth) {
  const w = String(paperWidth) === '80' ? 80 : 58;
  const printable = w === 80 ? 72 : 48;
  const font = w === 80 ? 12 : 11;
  const code = esc(Currency.code);
  const shop = Auth.currentShop || {};
  const cashier = order.cashier_id && order.cashier_id === Auth.currentUser?.id
    ? (Auth.currentProfile?.full_name || '') : '';
  const row = (l, r, bold) => `<div class="r${bold ? ' b' : ''}"><span>${l}</span><span>${r}</span></div>`;

  const lines = (items || []).map((i) => `
    <div class="it">${esc(i.product_name || 'Item')}</div>
    ${row(`${Number(i.quantity)} x ${Currency.fmt(i.unit_price)}`, Currency.fmt(i.total ?? Number(i.quantity) * Number(i.unit_price)))}`).join('');

  const pays = (payments || []).map((p) =>
    row(esc(METHODS[p.payment_method] || String(p.payment_method || '').toUpperCase()), Currency.fmt(p.amount)) +
    (p.reference_code ? `<div class="s">Ref: ${esc(p.reference_code)}</div>` : '')).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(order.receipt_no)}</title>
<style>
  @page { size: ${w}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 3mm ${(w - printable) / 2}mm 6mm; width: ${w}mm; font: ${font}px/1.35 'Courier New', monospace; color: #000; }
  .c { text-align: center; } .h { font-size: ${font + 3}px; font-weight: 700; }
  .s { font-size: ${font - 1}px; } .b { font-weight: 700; }
  .r { display: flex; justify-content: space-between; gap: 6px; }
  .it { margin-top: 4px; word-break: break-word; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
</style></head><body>
  <div class="c h">${esc(shop.name || 'QuickSell POS')}</div>
  ${shop.address ? `<div class="c s">${esc(shop.address)}</div>` : ''}
  ${shop.phone ? `<div class="c s">Tel: ${esc(shop.phone)}</div>` : ''}
  <hr>
  ${row('Receipt', esc(order.receipt_no))}
  ${row('Date', esc(new Date(order.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })))}
  ${cashier ? row('Served by', esc(cashier)) : ''}
  <hr>
  ${lines || '<div class="s">No item details</div>'}
  <hr>
  ${row('Subtotal', Currency.fmt(order.subtotal))}
  ${Number(order.discount_amount) ? row('Discount', '-' + Currency.fmt(order.discount_amount)) : ''}
  ${Number(order.tax_amount) ? row('Tax', Currency.fmt(order.tax_amount)) : ''}
  ${row(`TOTAL (${code})`, Currency.fmt(order.total), true)}
  <hr>
  ${pays}
  <hr>
  <div class="c">Thank you for shopping with us!</div>
</body></html>`;
}

export function printReceipt(order, items, payments) {
  const { paperWidth } = Prefs.get();
  const html = buildReceiptHtml(order, items, payments, paperWidth);

  document.getElementById('qs-print-frame')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'qs-print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden;';
  document.body.appendChild(frame);

  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  setTimeout(() => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (err) {
      alert('Could not open the print dialog: ' + err.message);
    }
    setTimeout(() => frame.remove(), 60000);
  }, 300);
}

export function printTestReceipt() {
  const now = new Date().toISOString();
  printReceipt(
    { receipt_no: 'TEST-0001', created_at: now, cashier_id: Auth.currentUser?.id, subtotal: 350, discount_amount: 0, tax_amount: 0, total: 350 },
    [
      { product_name: 'Sample item A', quantity: 2, unit_price: 100, total: 200 },
      { product_name: 'Sample item B', quantity: 1, unit_price: 150, total: 150 },
    ],
    [{ payment_method: 'cash', amount: 350 }]
  );
}
