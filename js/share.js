// Receipt sharing: Text, PDF, online Link and Email. Used by the "payment done" screen and Past Receipts.
import { Auth, supabase } from './auth.js';
import { CONFIG } from './config.js';
import { Currency } from './currency.js';
import { UI } from './ui.js';

const METHODS = { cash: 'Cash', mpesa: 'Mobile Money', card: 'Card' };
const money = (n) => Currency.fmt(n);
const when = (o) => new Date(o.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const shopName = () => Auth.currentShop?.name || 'QuickSell POS';
const methodLabel = (p) => METHODS[p.payment_method] || String(p.payment_method || '').toUpperCase();

// ---------- Text (chat apps: proportional font, so no column alignment) ----------
export function receiptText(order, items, payments) {
  const L = [];
  L.push(`*${shopName()}*`);
  L.push(`Receipt ${order.receipt_no}`);
  L.push(when(order));
  L.push('');
  (items || []).forEach((i) => {
    L.push(`${i.product_name || 'Item'}`);
    L.push(`  ${Number(i.quantity)} x ${money(i.unit_price)} = ${money(i.total ?? Number(i.quantity) * Number(i.unit_price))}`);
  });
  L.push('');
  L.push(`Subtotal: ${money(order.subtotal)}`);
  if (Number(order.discount_amount)) L.push(`Discount: -${money(order.discount_amount)}`);
  if (Number(order.tax_amount)) L.push(`Tax: ${money(order.tax_amount)}`);
  L.push(`*Total: ${Currency.code} ${money(order.total)}*`);
  (payments || []).forEach((p) => L.push(`Paid ${methodLabel(p)}: ${money(p.amount)}${p.reference_code ? ' (' + p.reference_code + ')' : ''}`));
  L.push('');
  L.push('Thank you for shopping with us!');
  return L.join('\n');
}

// ---------- PDF (tiny built-in writer: monospaced text on a receipt-sized page, no libraries) ----------
const COLS = 36;
const lr = (l, r) => {
  const left = String(l); const right = String(r);
  const gap = Math.max(1, COLS - left.length - right.length);
  return left.slice(0, Math.max(0, COLS - right.length - 1)) + ' '.repeat(gap) + right;
};
const centre = (s) => ' '.repeat(Math.max(0, Math.floor((COLS - s.length) / 2))) + s;
const wrap = (s) => { const out = []; let t = String(s); while (t.length > COLS) { out.push(t.slice(0, COLS)); t = t.slice(COLS); } out.push(t); return out; };

export function receiptPdfLines(order, items, payments) {
  const rule = '-'.repeat(COLS);
  const L = [];
  wrap(shopName()).forEach((l) => L.push(centre(l.trim())));
  L.push(rule);
  L.push(lr('Receipt', order.receipt_no));
  L.push(lr('Date', new Date(order.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })));
  L.push(rule);
  (items || []).forEach((i) => {
    wrap(i.product_name || 'Item').forEach((l) => L.push(l));
    L.push(lr(`${Number(i.quantity)} x ${money(i.unit_price)}`, money(i.total ?? Number(i.quantity) * Number(i.unit_price))));
  });
  L.push(rule);
  L.push(lr('Subtotal', money(order.subtotal)));
  if (Number(order.discount_amount)) L.push(lr('Discount', '-' + money(order.discount_amount)));
  if (Number(order.tax_amount)) L.push(lr('Tax', money(order.tax_amount)));
  L.push(lr(`TOTAL (${Currency.code})`, money(order.total)));
  L.push(rule);
  (payments || []).forEach((p) => {
    L.push(lr(methodLabel(p), money(p.amount)));
    if (p.reference_code) L.push(`Ref: ${p.reference_code}`);
  });
  L.push(rule);
  L.push(centre('Thank you for shopping with us!').slice(0, COLS));
  return L;
}

export function buildPdfBlob(lines) {
  const W = 226.8, M = 12, LEAD = 12, SIZE = 9;
  const H = Math.max(220, M * 2 + lines.length * LEAD + SIZE);
  const esc = (s) => String(s).replace(/[^\x20-\x7E]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 ${SIZE} Tf ${LEAD} TL ${M} ${(H - M - SIZE).toFixed(2)} Td\n${lines.map((l) => `(${esc(l)}) Tj T*`).join('\n')}\nET`;
  const objs = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H.toFixed(2)}] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 5; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([out], { type: 'application/pdf' });
}

// ---------- Online link / email need the sale to exist on the server ----------
export function receiptLink(orderId) {
  return `${new URL('receipt.html', location.href).href}?o=${encodeURIComponent(orderId)}`;
}

async function isOnServer(orderId) {
  if (!navigator.onLine || !supabase) return false;
  const { data, error } = await supabase.rpc('get_public_receipt', { p_order_id: orderId });
  return !error && !!data;
}

export async function emailReceipt(order, email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) throw new Error('Enter a valid email address.');
  if (!navigator.onLine) throw new Error('Connect to the internet to email a receipt.');
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/send-receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ order_id: order.id, email: String(email).trim() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'The email could not be sent.');
}

// ---------- Share actions ----------
async function shareText(order, items, payments) {
  const text = receiptText(order, items, payments);
  if (navigator.share) {
    try { await navigator.share({ title: `Receipt ${order.receipt_no}`, text }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    return;
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

async function sharePdf(order, items, payments) {
  const blob = buildPdfBlob(receiptPdfLines(order, items, payments));
  const file = new File([blob], `receipt-${order.receipt_no}.pdf`, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Receipt ${order.receipt_no}` }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function shareLink(order) {
  if (!(await isOnServer(order.id))) {
    throw new Error('This sale has not reached the server yet, so it has no online link. Connect to the internet, let it sync, then try again.');
  }
  const url = receiptLink(order.id);
  if (navigator.share) {
    try { await navigator.share({ title: `Receipt ${order.receipt_no}`, url }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    return;
  }
  await navigator.clipboard.writeText(url);
  UI.alert('Receipt link copied.');
}

// ---------- Dialog: Text / PDF / Link / Email ----------
const ICONS = {
  text: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><text x="7" y="17" font-size="6" font-weight="700" fill="currentColor" stroke="none">PDF</text>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;

export function openShareDialog(order, items, payments, opts = {}) {
  document.getElementById('qs-share-dialog')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'qs-share-dialog';
  wrap.style.cssText = 'position:fixed; inset:0; z-index:9900; background:rgba(15,23,42,.55); display:flex; align-items:center; justify-content:center; padding:20px;';
  const opt = (k, label, checked) => `
    <label style="flex:1; text-align:center; cursor:pointer; color:#94a3b8;">
      ${svg(k)}
      <div style="margin-top:10px; font-size:0.9rem; color:#0f172a; display:flex; align-items:center; justify-content:center; gap:6px;">
        <input type="radio" name="qs-share-mode" value="${k}" ${checked ? 'checked' : ''} style="accent-color:#0d9488; width:18px; height:18px;"> ${label}
      </div>
    </label>`;
  wrap.innerHTML = `
    <div style="background:#fff; width:100%; max-width:420px; border-radius:14px; padding:22px 18px 14px;">
      <div style="text-align:center; font-weight:700; margin-bottom:18px;">Share receipt</div>
      <div style="display:flex; gap:4px;">$${['text','pdf','link','email'].map((k) => opt(k, { text: 'Text', pdf: 'PDF', link: 'Link', email: 'Email' }[k], (opts.mode || 'text') === k)).join('')}</div>
      <input id="qs-share-email" type="email" inputmode="email" placeholder="Customer email address" value="${(opts.email || '').replace(/"/g, '&quot;')}"
        style="display:${(opts.mode || 'text') === 'email' ? 'block' : 'none'}; width:100%; margin-top:16px; padding:10px 4px; border:0; border-bottom:1.5px solid #cbd5e1; outline:none; font-size:1rem;" />
      <div id="qs-share-err" style="color:#b91c1c; font-size:0.85rem; margin-top:10px; min-height:1em;"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
        <button type="button" id="qs-share-cancel" style="border:0; background:none; color:#0f766e; font-weight:800; padding:12px 16px;">CANCEL</button>
        <button type="button" id="qs-share-ok" style="border:0; background:none; color:#0f766e; font-weight:800; padding:12px 16px;">OK</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const emailEl = wrap.querySelector('#qs-share-email');
  const errEl = wrap.querySelector('#qs-share-err');
  const okBtn = wrap.querySelector('#qs-share-ok');
  const mode = () => wrap.querySelector('input[name="qs-share-mode"]:checked').value;
  wrap.querySelectorAll('input[name="qs-share-mode"]').forEach((r) => {
    r.onchange = () => { emailEl.style.display = mode() === 'email' ? 'block' : 'none'; errEl.textContent = ''; if (mode() === 'email') emailEl.focus(); };
  });
  const close = () => wrap.remove();
  wrap.querySelector('#qs-share-cancel').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };

  okBtn.onclick = async () => {
    errEl.textContent = '';
    okBtn.disabled = true;
    try {
      const m = mode();
      if (m === 'text') await shareText(order, items, payments);
      else if (m === 'pdf') await sharePdf(order, items, payments);
      else if (m === 'link') await shareLink(order);
      else { await emailReceipt(order, emailEl.value); UI.alert('Receipt emailed to ' + emailEl.value.trim()); }
      close();
    } catch (err) {
      errEl.textContent = err.message || String(err);
      okBtn.disabled = false;
    }
  };
}
