// Checkout flow: Payment screen -> (optional) Split screen -> "Payment done" screen with print / share / email.
import { Cart } from './cart.js';
import { Currency } from './currency.js';
import { Prefs, Device } from './prefs.js';
import { printReceipt } from './receipt.js';
import { openShareDialog, emailReceipt } from './share.js';
import { UI } from './ui.js';

const $ = (id) => document.getElementById(id);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => Currency.fmt(n);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');
const METHODS = [['cash', 'Cash'], ['mpesa', 'Mobile Money'], ['card', 'Card']];
const MAX_PARTS = 8;

let commit = null;      // async (payments) => { order, synced } | null
let onNewSale = null;
let total = 0;
let method = 'cash';
let rows = [];          // split rows: { method, amount, ref, paid }
let sale = null;
let saleEmail = '';
let busy = false;
let bound = false;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setBusy(on) {
  busy = on;
  ['btn-pay-charge'].forEach((id) => {
    const b = $(id);
    if (!b) return;
    b.disabled = on;
    b.textContent = on ? 'PROCESSING...' : 'CHARGE';
  });
  document.querySelectorAll('#split-rows [data-act="charge"]').forEach((b) => { if (!b.dataset.paid) b.disabled = on; });
}

async function finalize(payments, change) {
  if (busy) return false;
  saleEmail = Cart.selectedCustomer?.email || '';   // captured now: the ticket is cleared by the sale
  setBusy(true);
  try {
    const res = await commit(payments);
    if (!res) return false;         // refused or failed: stay on this screen
    sale = res;
    showPaid(change);
    return true;
  } finally {
    setBusy(false);
  }
}

// ---------------- Payment screen ----------------
function setMethod(m) {
  method = m;
  document.querySelectorAll('[data-pay-method]').forEach((b) => b.classList.toggle('active', b.dataset.payMethod === m));
  $('pay-cash-wrap').classList.toggle('hidden', m !== 'cash');
  $('pay-ref-wrap').classList.toggle('hidden', m === 'cash');
  $('pay-ref-label').textContent = m === 'mpesa' ? 'Mobile money reference' : 'Card / terminal reference';
}

function updateChange() {
  const tendered = parseFloat($('pay-cash-input').value);
  const el = $('pay-change');
  if (Number.isNaN(tendered) || tendered + 0.005 < total) {
    el.textContent = Number.isNaN(tendered) ? '-' : `Short ${fmt(total - tendered)}`;
    el.style.color = '#b91c1c';
  } else {
    el.textContent = fmt(r2(tendered - total));
    el.style.color = '';
  }
}

function open() {
  total = r2(Cart.getTotals().grandTotal);
  busy = false;
  $('pay-total').textContent = fmt(total);
  $('pay-cur').textContent = Currency.code;
  $('pay-cash-input').value = total.toFixed(2);
  $('pay-ref').value = '';
  setMethod('cash');
  updateChange();
  hide('screen-split');
  hide('screen-paid');
  show('screen-payment');
}

async function chargeSingle() {
  let change = 0;
  if (method === 'cash') {
    const tendered = parseFloat($('pay-cash-input').value);
    if (Number.isNaN(tendered) || tendered + 0.005 < total) return UI.alert('Cash received is less than the total.');
    change = r2(tendered - total);
  }
  const ref = $('pay-ref').value.trim();
  await finalize([{ method, amount: total, ref: method === 'cash' ? '' : ref }], change);
}

// ---------------- Split screen ----------------
const paidSum = () => r2(rows.filter((r) => r.paid).reduce((s, r) => s + r.amount, 0));
const remaining = () => r2(total - paidSum());

function rebalance(fixedIdx = -1) {
  const idx = rows.map((_, i) => i).filter((i) => !rows[i].paid && i !== fixedIdx);
  let left = r2(remaining() - (fixedIdx >= 0 ? rows[fixedIdx].amount : 0));
  if (left < 0) left = 0;
  idx.forEach((i, k) => {
    const share = k === idx.length - 1 ? left : r2(left / idx.length);
    rows[i].amount = share;
    left = r2(left - share);
  });
}

function renderSplit() {
  $('split-remaining').textContent = fmt(Math.max(0, remaining()));
  $('split-cur').textContent = Currency.code;
  $('split-count').textContent = rows.length;
  $('split-rows').innerHTML = rows.map((r, i) => `
    <div class="split-row" data-i="${i}">
      <div class="split-line">
        <button type="button" class="split-del" data-act="del" ${r.paid ? 'disabled' : ''} aria-label="Remove payment">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>
        </button>
        <select data-act="method" ${r.paid ? 'disabled' : ''}>
          ${METHODS.map(([v, l]) => `<option value="${v}" ${v === r.method ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <input type="number" inputmode="decimal" step="0.01" min="0" data-act="amount" value="${r.amount.toFixed(2)}" ${r.paid ? 'disabled' : ''} />
        <button type="button" class="split-charge" data-act="charge" ${r.paid ? 'data-paid="1" disabled' : ''}>${r.paid ? 'PAID' : 'CHARGE'}</button>
      </div>
      ${(!r.paid && r.method !== 'cash') ? `<input type="text" class="split-ref" data-act="ref" placeholder="${r.method === 'mpesa' ? 'Mobile money reference (optional)' : 'Card reference (optional)'}" value="${esc(r.ref)}" />` : ''}
    </div>`).join('');
}

function openSplit() {
  rows = [{ method: 'cash', amount: 0, ref: '', paid: false }, { method: 'cash', amount: 0, ref: '', paid: false }];
  rebalance();
  hide('screen-payment');
  show('screen-split');
  renderSplit();
}

async function leaveSplit() {
  if (rows.some((r) => r.paid) && !await UI.confirm('Go back and discard the payments already taken on this screen? Nothing has been recorded yet.')) return;
  rows = [];
  hide('screen-split');
  show('screen-payment');
}

async function chargeRow(i) {
  const rowEl = $('split-rows').querySelector(`.split-row[data-i="${i}"]`);
  const r = rows[i];
  if (!r || r.paid) return;
  let amt = r2(parseFloat(rowEl.querySelector('[data-act="amount"]').value));
  if (Number.isNaN(amt) || amt <= 0) return UI.alert('Enter an amount greater than 0.');
  amt = Math.min(amt, remaining());
  r.amount = amt;
  const refEl = rowEl.querySelector('[data-act="ref"]');
  if (refEl) r.ref = refEl.value.trim();
  r.paid = true;

  if (remaining() <= 0.005) {
    const payments = rows.filter((x) => x.paid).map((x) => ({ method: x.method, amount: x.amount, ref: x.method === 'cash' ? '' : x.ref }));
    if (!(await finalize(payments, 0))) { r.paid = false; rebalance(); renderSplit(); }
    return;
  }
  rebalance();
  renderSplit();
}

function onSplitChange(e) {
  const row = e.target.closest('.split-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  const r = rows[i];
  const act = e.target.dataset.act;
  if (act === 'method') { r.method = e.target.value; renderSplit(); }
  else if (act === 'ref') { r.ref = e.target.value; }
  else if (act === 'amount') {
    let v = r2(parseFloat(e.target.value));
    if (Number.isNaN(v) || v < 0) v = 0;
    v = Math.min(v, remaining());
    const others = rows.some((x, k) => k !== i && !x.paid);
    r.amount = others ? v : remaining();
    rebalance(i);
    renderSplit();
  }
}

function onSplitClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !['del', 'charge'].includes(btn.dataset.act)) return;
  const i = Number(btn.closest('.split-row').dataset.i);
  if (btn.dataset.act === 'charge') return void chargeRow(i);
  if (rows.filter((x) => !x.paid).length <= 1) return UI.alert('At least one payment must remain.');
  rows.splice(i, 1);
  rebalance();
  renderSplit();
}

function stepParts(delta) {
  if (delta > 0) {
    if (rows.length >= MAX_PARTS) return;
    rows.push({ method: 'cash', amount: 0, ref: '', paid: false });
  } else {
    const unpaid = rows.map((_, i) => i).filter((i) => !rows[i].paid);
    if (unpaid.length <= 1) return;
    rows.splice(unpaid[unpaid.length - 1], 1);
  }
  rebalance();
  renderSplit();
}

// ---------------- Payment done screen ----------------
function showPaid(change) {
  const o = sale.order;
  hide('screen-payment');
  hide('screen-split');
  $('paid-total').textContent = fmt(o.total);
  $('paid-change').textContent = fmt(change);
  $('paid-email').value = saleEmail;
  $('paid-offline').classList.toggle('hidden', !!sale.synced);
  show('screen-paid');
  Device.success();
  if (Prefs.get().autoPrint === 'yes') printReceipt(o, o.items, o.payments);
}

async function sendEmail() {
  const btn = $('btn-paid-send');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'SENDING...';
  try {
    await emailReceipt(sale.order, $('paid-email').value);
    UI.alert('Receipt sent to ' + $('paid-email').value.trim());
  } catch (err) {
    UI.alert(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function bind() {
  if (bound) return;
  bound = true;
  document.querySelectorAll('[data-pay-method]').forEach((b) => { b.onclick = () => setMethod(b.dataset.payMethod); });
  $('pay-cash-input').oninput = updateChange;
  $('pay-cash-input').onfocus = (e) => e.target.select();
  $('btn-pay-back').onclick = () => hide('screen-payment');
  $('btn-pay-customer').onclick = () => $('btn-open-customer-modal')?.click();
  $('btn-pay-split').onclick = openSplit;
  $('btn-pay-charge').onclick = chargeSingle;

  $('btn-split-back').onclick = leaveSplit;
  $('split-minus').onclick = () => stepParts(-1);
  $('split-plus').onclick = () => stepParts(1);
  $('split-rows').addEventListener('change', onSplitChange);
  $('split-rows').addEventListener('click', onSplitClick);

  $('btn-paid-share').onclick = () => openShareDialog(sale.order, sale.order.items, sale.order.payments, { email: $('paid-email').value });
  $('btn-paid-send').onclick = sendEmail;
  $('btn-paid-print').onclick = () => printReceipt(sale.order, sale.order.items, sale.order.payments);
  $('btn-paid-new').onclick = () => { hide('screen-paid'); sale = null; onNewSale?.(); };
}

export const Checkout = {
  init(opts) { commit = opts.commit; onNewSale = opts.onNewSale; bind(); },
  open,
};
