import { IDB } from './idb.js';
import { SyncEngine } from './sync.js';
import { CONFIG } from './config.js';
import { Router } from './router.js';
import { Auth, supabase } from './auth.js';
import { Cart } from './cart.js';

let pendingEmail = '';
let currentCustomizingProduct = null;
let customDiscountMode = 'pct'; // 'pct' | 'fixed'
let productsList = [];
let categoriesList = [];

document.addEventListener('DOMContentLoaded', async () => {
  Router.init();
  if (window.lucide) window.lucide.createIcons();

  // 1. Initialize IndexedDB
  await IDB.init();

  // 2. Service Worker for Offline PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(console.warn);
  }

  // 3. Online/Offline UI listener
  const statusPill = document.getElementById('connection-status-pill');
  SyncEngine.init((isOnline) => {
    statusPill.style.display = isOnline ? 'none' : 'block';
  });

  // 4. Session Validation
  const session = await Auth.syncSession();
  if (session?.user) {
    bootTerminal();
  } else {
    Router.navigate('splash');
  }

  // Bind UI Handlers
  bindAuthFlows();
  bindTerminalActions();
});

function bootTerminal() {
  const shop = Auth.currentShop;
  Cart.init(shop?.id);

  document.getElementById('lbl-pos-currency').textContent = shop?.currency || 'KES';
  document.getElementById('drawer-user-role').textContent = (Auth.currentProfile?.role || 'CASHIER').toUpperCase();
  document.getElementById('drawer-shop-name').textContent = shop?.name || 'QuickSell Terminal';

  Router.navigate('pos');
  loadCatalogData();
}

// =========================================================================
// Real Catalog Fetching (IndexedDB with Cloud Fallback)
// =========================================================================
async function loadCatalogData() {
  const container = document.getElementById('pos-items-container');
  const catSelect = document.getElementById('sel-pos-category');

  // Load from local IndexedDB
  productsList = await IDB.getCatalog();
  categoriesList = await IDB.getCategories();

  if (!productsList.length && navigator.onLine && Auth.currentShop?.id) {
    await Auth.refreshLocalCatalog(Auth.currentShop.id);
    productsList = await IDB.getCatalog();
    categoriesList = await IDB.getCategories();
  }

  // Render Category Select options
  catSelect.innerHTML = `<option value="all">All Items</option>` +
    categoriesList.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');

  renderProductRows(productsList);
}

function renderProductRows(items) {
  const container = document.getElementById('pos-items-container');
  const currency = Auth.currentShop?.currency || 'KES';

  if (!items.length) {
    container.innerHTML = `<p style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:0.9rem;">No products found in this branch catalog.</p>`;
    return;
  }

  container.innerHTML = items.map((item) => `
    <div class="product-list-row" data-id="${item.id}">
      <div class="product-row-left">
        <div class="product-row-circle">
          ${item.name.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <div style="font-weight:700; font-size:0.95rem; color:var(--text-main);">${item.name}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">${item.sku || 'SKU: -'}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-weight:700; font-size:0.95rem; color:var(--primary-teal-dark);">
          ${Number(item.retail_price).toFixed(2)}
        </span>
        <i data-lucide="info" style="width:18px; height:18px; color:var(--text-muted);"></i>
      </div>
    </div>
  `).join('');

  if (window.lucide) window.lucide.createIcons({ root: container });

  container.querySelectorAll('.product-list-row').forEach((row) => {
    row.onclick = () => {
      const found = items.find((p) => p.id === row.dataset.id);
      if (found) openItemCustomizer(found);
    };
  });
}

// =========================================================================
// Authentication & 8-Digit OTP Flow
// =========================================================================
function bindAuthFlows() {
  document.getElementById('btn-goto-signin').onclick = () => Router.navigate('signin');
  document.getElementById('btn-goto-register').onclick = () => Router.navigate('register');
  document.querySelectorAll('.btn-back-splash').forEach((b) => b.onclick = () => Router.navigate('splash'));
  document.querySelectorAll('.btn-back-signin').forEach((b) => b.onclick = () => Router.navigate('signin'));
  document.getElementById('btn-back-otp').onclick = () => Router.navigate('register');

  // Toggle Passwords
  const wireToggle = (btnId, inpId) => {
    const btn = document.getElementById(btnId);
    const inp = document.getElementById(inpId);
    if (btn && inp) {
      btn.onclick = () => inp.type = inp.type === 'password' ? 'text' : 'password';
    }
  };
  wireToggle('toggle-pwd-login', 'login-password');
  wireToggle('toggle-pwd-reg', 'reg-password');

  // Sign In Submission
  document.getElementById('form-mobile-login').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-submit-login');
    btn.disabled = true;
    btn.textContent = 'SIGNING IN...';

    const email = document.getElementById('login-email').value.trim();
    const pwd = document.getElementById('login-password').value;

    try {
      await Auth.signIn(email, pwd);
      bootTerminal();
    } catch (err) {
      alert(err.message || 'Invalid email or password.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'SUBMIT';
    }
  };

  // Registration Submission (Dispatches 8-Digit OTP)
  document.getElementById('form-mobile-reg').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-submit-reg');
    btn.disabled = true;
    btn.textContent = 'DISPATCHING CODE...';

    const fullName = document.getElementById('reg-fullname').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const bizName = document.getElementById('reg-biz-name').value.trim();
    const bizType = document.getElementById('reg-biz-type').value;
    const phone = document.getElementById('reg-phone').value.trim();
    const country = document.getElementById('reg-country').value;

    try {
      await Auth.signUp(email, password, fullName, bizName, bizType, phone, country);
      pendingEmail = email;
      document.getElementById('lbl-otp-target-email').textContent = email;
      Router.navigate('otp');
    } catch (err) {
      alert(err.message || 'Registration failed.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'SUBMIT';
    }
  };

  // Confirm 8-Digit Registration OTP
  document.getElementById('form-mobile-otp').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-verify-otp');
    btn.disabled = true;
    btn.textContent = 'VERIFYING...';

    const token = document.getElementById('inp-otp-code').value.trim();

    try {
      await Auth.verifySignUpOTP(pendingEmail, token);
      bootTerminal();
    } catch (err) {
      alert(err.message || 'Invalid or expired 8-digit OTP code.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'CONFIRM & LOGIN';
    }
  };

  // Forgot Password Transitions
  document.getElementById('link-goto-forgot').onclick = (e) => {
    e.preventDefault();
    Router.navigate('forgot');
  };

  document.getElementById('form-mobile-forgot').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    try {
      await Auth.requestPasswordReset(email);
      pendingEmail = email;
      alert('Password reset OTP sent to your inbox.');
      Router.navigate('reset-password');
    } catch (err) {
      alert(err.message);
    }
  };

  document.getElementById('form-mobile-reset-pass').onsubmit = async (e) => {
    e.preventDefault();
    const token = document.getElementById('reset-otp-token').value.trim();
    const newPass = document.getElementById('reset-new-password').value;

    try {
      await Auth.verifyPasswordResetOTP(pendingEmail, token);
      await Auth.updatePassword(newPass);
      alert('Password updated. Please log in.');
      Router.navigate('signin');
    } catch (err) {
      alert(err.message || 'Failed to reset password.');
    }
  };
}

// =========================================================================
// Terminal Operations: Customizer, Search, Drawer & Tender
// =========================================================================
function bindTerminalActions() {
  // 1. Drawer
  const drawer = document.getElementById('side-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  document.getElementById('btn-open-drawer').onclick = () => {
    drawer.classList.add('active');
    backdrop.classList.add('active');
  };
  backdrop.onclick = () => {
    drawer.classList.remove('active');
    backdrop.classList.remove('active');
  };
  document.getElementById('link-goto-backoffice').onclick = () => {
    window.open(CONFIG.BACKOFFICE_URL, '_blank');
  };
  document.getElementById('btn-drawer-logout').onclick = async () => {
    if (confirm('Log out of QuickSell POS?')) await Auth.signOut();
  };

  // 2. Overflow Menu
  const overflow = document.getElementById('overflow-popup');
  document.getElementById('btn-open-overflow').onclick = (e) => {
    e.stopPropagation();
    overflow.classList.toggle('hidden');
  };
  window.addEventListener('click', () => overflow.classList.add('hidden'));

  document.getElementById('opt-clear-cart').onclick = () => {
    if (confirm('Clear current sale items?')) {
      Cart.clearTicket(true);
      overflow.classList.add('hidden');
    }
  };

  document.getElementById('opt-trigger-sync').onclick = async () => {
    overflow.classList.add('hidden');
    await Auth.refreshLocalCatalog(Auth.currentShop?.id);
    await loadCatalogData();
    await SyncEngine.syncPendingData();
    alert('Catalog and pending orders synchronized.');
  };

  // 3. Search and Category Filters
  const searchWrap = document.getElementById('search-input-wrap');
  const searchInput = document.getElementById('inp-pos-search');
  document.getElementById('btn-toggle-search').onclick = () => {
    searchWrap.classList.toggle('hidden');
    if (!searchWrap.classList.contains('hidden')) searchInput.focus();
  };

  const filterCatalog = () => {
    const term = searchInput.value.toLowerCase().trim();
    const cat = document.getElementById('sel-pos-category').value;
    const filtered = productsList.filter((p) => {
      const matchCat = cat === 'all' || p.category_id === cat;
      const matchText = !term || p.name.toLowerCase().includes(term) || (p.barcode && p.barcode.includes(term));
      return matchCat && matchText;
    });
    renderProductRows(filtered);
  };

  searchInput.oninput = filterCatalog;
  document.getElementById('sel-pos-category').onchange = filterCatalog;

  // 4. Line Customizer Modal
  const modalCust = document.getElementById('modal-item-customizer');
  document.getElementById('btn-close-customizer').onclick = () => modalCust.classList.add('hidden');

  document.getElementById('btn-qty-minus').onclick = () => {
    const inp = document.getElementById('inp-custom-qty');
    inp.value = Math.max(1, parseFloat(inp.value || 1) - 1);
  };
  document.getElementById('btn-qty-plus').onclick = () => {
    const inp = document.getElementById('inp-custom-qty');
    inp.value = parseFloat(inp.value || 1) + 1;
  };

  document.getElementById('btn-disc-mode-fixed').onclick = () => {
    customDiscountMode = 'fixed';
    document.getElementById('btn-disc-mode-fixed').style.background = 'var(--primary-teal-light)';
    document.getElementById('btn-disc-mode-pct').style.background = '#f1f5f9';
  };
  document.getElementById('btn-disc-mode-pct').onclick = () => {
    customDiscountMode = 'pct';
    document.getElementById('btn-disc-mode-pct').style.background = 'var(--primary-teal-light)';
    document.getElementById('btn-disc-mode-fixed').style.background = '#f1f5f9';
  };

  document.getElementById('btn-confirm-item-add').onclick = () => {
    if (!currentCustomizingProduct) return;
    const qty = parseFloat(document.getElementById('inp-custom-qty').value) || 1;
    const price = parseFloat(document.getElementById('inp-custom-price').value) || 0;
    const disc = parseFloat(document.getElementById('inp-custom-discount').value) || 0;
    const remark = document.getElementById('inp-custom-remark').value.trim();

    Cart.addItem(currentCustomizingProduct, qty, price, disc, customDiscountMode, remark);
    modalCust.classList.add('hidden');
  };

  // 5. Customer Selector Modal
  const modalCustList = document.getElementById('modal-customer');
  document.getElementById('btn-open-customer-modal').onclick = async () => {
    modalCustList.classList.remove('hidden');
    renderCustomerList();
  };
  document.getElementById('btn-close-customer').onclick = () => modalCustList.classList.add('hidden');

  // 6. Tender Checkout Modal
  const modalTender = document.getElementById('modal-tender');
  document.getElementById('btn-charge-ticket').onclick = () => {
    if (!Cart.items.length) {
      alert('Your ticket is empty.');
      return;
    }
    const totals = Cart.getTotals();
    document.getElementById('tender-grand-total').textContent = totals.grandTotal.toFixed(2);
    document.getElementById('inp-tender-cash-paid').value = totals.grandTotal.toFixed(2);
    document.getElementById('lbl-tender-change').textContent = '0.00';
    modalTender.classList.remove('hidden');
  };
  document.getElementById('btn-close-tender').onclick = () => modalTender.classList.add('hidden');

  const paySelect = document.getElementById('tender-payment-method');
  const cashFields = document.getElementById('tender-cash-fields');
  const refFields = document.getElementById('tender-ref-fields');
  const cashPaidInput = document.getElementById('inp-tender-cash-paid');

  paySelect.onchange = () => {
    if (paySelect.value === 'cash') {
      cashFields.classList.remove('hidden');
      refFields.classList.add('hidden');
    } else {
      cashFields.classList.add('hidden');
      refFields.classList.remove('hidden');
    }
  };

  cashPaidInput.oninput = () => {
    const paid = parseFloat(cashPaidInput.value) || 0;
    const total = Cart.getTotals().grandTotal;
    document.getElementById('lbl-tender-change').textContent = Math.max(0, paid - total).toFixed(2);
  };

  document.getElementById('btn-commit-tender').onclick = async () => {
    await commitSaleTransaction();
  };
}

function openItemCustomizer(product) {
  currentCustomizingProduct = product;
  const modal = document.getElementById('modal-item-customizer');
  document.getElementById('customizer-item-name').textContent = product.name;
  document.getElementById('inp-custom-price').value = Number(product.retail_price).toFixed(2);
  document.getElementById('inp-custom-qty').value = 1;
  document.getElementById('inp-custom-discount').value = '0.00';
  document.getElementById('inp-custom-remark').value = '';
  modal.classList.remove('hidden');
}

async function renderCustomerList() {
  const container = document.getElementById('customer-list-wrap');
  const customers = await IDB.getCustomers();

  if (!customers.length) {
    container.innerHTML = `<p style="padding:20px; text-align:center; color:var(--text-muted);">No customers saved.</p>`;
    return;
  }

  container.innerHTML = customers.map((c) => `
    <div class="product-list-row" data-cust-id="${c.id}" style="padding:10px 0;">
      <div>
        <strong>${c.name}</strong>
        <div style="font-size:0.75rem; color:var(--text-muted);">${c.phone || 'No phone'}</div>
      </div>
      <button class="btn-outline-blue" style="height:32px; font-size:0.75rem; width:auto; padding:0 12px;">SELECT</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-cust-id]').forEach((row) => {
    row.onclick = () => {
      const cust = customers.find((c) => c.id === row.dataset.custId);
      Cart.selectedCustomer = cust;
      alert(`Customer '${cust.name}' attached to ticket.`);
      document.getElementById('modal-customer').classList.add('hidden');
    };
  });
}

// =========================================================================
// Commit Transaction (Instant Offline Queue or Direct Supabase Write)
// =========================================================================
async function commitSaleTransaction() {
  const totals = Cart.getTotals();
  const paymentMethod = document.getElementById('tender-payment-method').value;
  const receiptNo = `QS-M-${Date.now().toString().slice(-7)}`;
  const orderId = crypto.randomUUID();

  const orderPayload = {
    id: orderId,
    shop_id: Auth.currentShop?.id,
    cashier_id: Auth.currentUser?.id,
    customer_id: Cart.selectedCustomer?.id || null,
    receipt_no: receiptNo,
    subtotal: totals.subtotal,
    discount_amount: totals.discountAmount,
    tax_amount: totals.taxAmount,
    total: totals.grandTotal,
    items: Cart.items.map((i) => ({
      order_id: orderId,
      product_id: i.id,
      product_name: i.name,
      quantity: i.quantity,
      unit_price: i.unitPrice,
      cost_price: i.costPrice,
      total: i.total,
    })),
    payments: [{
      order_id: orderId,
      payment_method: paymentMethod,
      amount: totals.grandTotal,
    }],
    created_at: new Date().toISOString(),
  };

  if (navigator.onLine) {
    try {
      await supabase.from('orders').insert([{
        id: orderPayload.id,
        shop_id: orderPayload.shop_id,
        cashier_id: orderPayload.cashier_id,
        customer_id: orderPayload.customer_id,
        receipt_no: orderPayload.receipt_no,
        subtotal: orderPayload.subtotal,
        discount_amount: orderPayload.discount_amount,
        tax_amount: orderPayload.tax_amount,
        total: orderPayload.total,
        order_status: 'completed',
        synced_from_offline: false,
      }]);

      await supabase.from('order_items').insert(orderPayload.items);
      await supabase.from('payments').insert(orderPayload.payments);
    } catch (err) {
      console.warn('Network write failed, saving to offline queue:', err);
      await IDB.saveOfflineOrder(orderPayload);
    }
  } else {
    // Offline mode: store sale locally
    await IDB.saveOfflineOrder(orderPayload);
  }

  alert(`Sale committed successfully! Receipt: ${receiptNo}`);
  document.getElementById('modal-tender').classList.add('hidden');
  Cart.clearTicket(false);
      }
        
