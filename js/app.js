import { IDB } from './idb.js';
import { SyncEngine } from './sync.js';
import { CONFIG } from './config.js';
import { Router } from './router.js';
import { Auth, supabase } from './auth.js';
import { Cart } from './cart.js';

let pendingEmail = '';
let currentCustomizingProduct = null;
let customDiscountMode = 'pct';
let productsList = [];
let categoriesList = [];

// =========================================================================
// Primary Bootstrap (Guaranteed Synchronous Event Binding)
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Initialize Views and Icons
  Router.init();
  if (window.lucide) window.lucide.createIcons();

  // 2. Bind DOM Handlers Immediately
  bindNavigationEvents();
  bindAuthFlows();
  bindTerminalActions();

  // 3. Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(console.warn);
  }

  // 4. Initialize Local IndexedDB
  try {
    await IDB.init();
  } catch (err) {
    console.warn('[IDB] Local storage fallback:', err);
  }

  // 5. Check Active Authentication Session
  try {
    const session = await Auth.syncSession();
    if (session?.user) {
      bootTerminal();
    } else {
      Router.navigate('splash', false);
    }
  } catch (err) {
    console.warn('[Auth] Running in offline / unauthenticated mode:', err);
    Router.navigate('splash', false);
  }
});

// =========================================================================
// Navigation & Transition Handlers (Guaranteed Clicks)
// =========================================================================
function bindNavigationEvents() {
  const gotoSignin = document.getElementById('btn-goto-signin');
  if (gotoSignin) {
    gotoSignin.onclick = (e) => {
      e.preventDefault();
      Router.navigate('signin');
    };
  }

  const gotoRegister = document.getElementById('btn-goto-register');
  if (gotoRegister) {
    gotoRegister.onclick = (e) => {
      e.preventDefault();
      Router.navigate('register');
    };
  }

  // All Back Buttons to Splash
  document.querySelectorAll('.btn-back-splash').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      Router.navigate('splash');
    };
  });

  // Back to Signin
  document.querySelectorAll('.btn-back-signin').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      Router.navigate('signin');
    };
  });

  // Back from OTP
  const backOtp = document.getElementById('btn-back-otp');
  if (backOtp) {
    backOtp.onclick = (e) => {
      e.preventDefault();
      Router.navigate('register');
    };
  }
}

// =========================================================================
// Terminal Initializer
// =========================================================================
function bootTerminal() {
  const shop = Auth.currentShop;
  Cart.init(shop?.id);

  const currencyEl = document.getElementById('lbl-pos-currency');
  if (currencyEl) currencyEl.textContent = shop?.currency || 'KES';

  const roleEl = document.getElementById('drawer-user-role');
  if (roleEl) roleEl.textContent = (Auth.currentProfile?.role || 'CASHIER').toUpperCase();

  const shopEl = document.getElementById('drawer-shop-name');
  if (shopEl) shopEl.textContent = shop?.name || 'QuickSell Terminal';

  Router.navigate('pos');
  loadCatalogData();
}

// =========================================================================
// Catalog Fetching (IndexedDB with Cloud Fallback)
// =========================================================================
async function loadCatalogData() {
  const catSelect = document.getElementById('sel-pos-category');

  productsList = await IDB.getCatalog();
  categoriesList = await IDB.getCategories();

  if (!productsList.length && navigator.onLine && Auth.currentShop?.id) {
    await Auth.refreshLocalCatalog(Auth.currentShop.id);
    productsList = await IDB.getCatalog();
    categoriesList = await IDB.getCategories();
  }

  if (catSelect) {
    catSelect.innerHTML = `<option value="all">All Items</option>` +
      categoriesList.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  renderProductRows(productsList);
}

function renderProductRows(items) {
  const container = document.getElementById('pos-items-container');
  if (!container) return;

  if (!items || !items.length) {
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
// Authentication Execution (8-Digit OTP & Password Reset)
// =========================================================================
function bindAuthFlows() {
  const wireToggle = (btnId, inpId) => {
    const btn = document.getElementById(btnId);
    const inp = document.getElementById(inpId);
    if (btn && inp) {
      btn.onclick = () => inp.type = inp.type === 'password' ? 'text' : 'password';
    }
  };
  wireToggle('toggle-pwd-login', 'login-password');
  wireToggle('toggle-pwd-reg', 'reg-password');

  // 1. Sign In
  const formLogin = document.getElementById('form-mobile-login');
  if (formLogin) {
    formLogin.onsubmit = async (e) => {
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
  }

  // 2. Registration (8-Digit OTP via Brevo)
  const formReg = document.getElementById('form-mobile-reg');
  if (formReg) {
    formReg.onsubmit = async (e) => {
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
        const targetEmailEl = document.getElementById('lbl-otp-target-email');
        if (targetEmailEl) targetEmailEl.textContent = email;
        Router.navigate('otp');
      } catch (err) {
        alert(err.message || 'Registration failed.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'SUBMIT';
      }
    };
  }

  // 3. Confirm 8-Digit OTP
  const formOtp = document.getElementById('form-mobile-otp');
  if (formOtp) {
    formOtp.onsubmit = async (e) => {
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
  }

  // 4. Password Recovery
  const linkForgot = document.getElementById('link-goto-forgot');
  if (linkForgot) {
    linkForgot.onclick = (e) => {
      e.preventDefault();
      Router.navigate('forgot');
    };
  }

  const formForgot = document.getElementById('form-mobile-forgot');
  if (formForgot) {
    formForgot.onsubmit = async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgot-email').value.trim();
      try {
        await Auth.requestPasswordReset(email);
        pendingEmail = email;
        alert('Password recovery OTP sent to your email.');
        Router.navigate('reset-password');
      } catch (err) {
        alert(err.message);
      }
    };
  }

  const formResetPass = document.getElementById('form-mobile-reset-pass');
  if (formResetPass) {
    formResetPass.onsubmit = async (e) => {
      e.preventDefault();
      const token = document.getElementById('reset-otp-token').value.trim();
      const newPass = document.getElementById('reset-new-password').value;

      try {
        await Auth.verifyPasswordResetOTP(pendingEmail, token);
        await Auth.updatePassword(newPass);
        alert('Password reset successfully. Please sign in.');
        Router.navigate('signin');
      } catch (err) {
        alert(err.message || 'Reset verification failed.');
      }
    };
  }
}

// =========================================================================
// Terminal Operations: Drawer, Customizer, Customer & Tender
// =========================================================================
function bindTerminalActions() {
  const drawer = document.getElementById('side-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const openDrawer = document.getElementById('btn-open-drawer');
  
  if (openDrawer && drawer && backdrop) {
    openDrawer.onclick = () => {
      drawer.classList.add('active');
      backdrop.classList.add('active');
    };
    backdrop.onclick = () => {
      drawer.classList.remove('active');
      backdrop.classList.remove('active');
    };
  }

  const backOfficeLink = document.getElementById('link-goto-backoffice');
  if (backOfficeLink) {
    backOfficeLink.onclick = () => window.open(CONFIG.BACKOFFICE_URL, '_blank');
  }

  const logoutBtn = document.getElementById('btn-drawer-logout');
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      if (confirm('Log out of QuickSell POS?')) await Auth.signOut();
    };
  }

  // Overflow 3-Dot Menu
  const overflow = document.getElementById('overflow-popup');
  const openOverflow = document.getElementById('btn-open-overflow');
  if (openOverflow && overflow) {
    openOverflow.onclick = (e) => {
      e.stopPropagation();
      overflow.classList.toggle('hidden');
    };
    window.addEventListener('click', () => overflow.classList.add('hidden'));
  }

  const optClear = document.getElementById('opt-clear-cart');
  if (optClear) {
    optClear.onclick = () => {
      if (confirm('Clear current ticket items?')) {
        Cart.clearTicket(true);
        if (overflow) overflow.classList.add('hidden');
      }
    };
  }

  const optSync = document.getElementById('opt-trigger-sync');
  if (optSync) {
    optSync.onclick = async () => {
      if (overflow) overflow.classList.add('hidden');
      await Auth.refreshLocalCatalog(Auth.currentShop?.id);
      await loadCatalogData();
      await SyncEngine.syncPendingData();
      alert('Catalog and sales synchronized.');
    };
  }

  // Search Toggle
  const searchWrap = document.getElementById('search-input-wrap');
  const searchInput = document.getElementById('inp-pos-search');
  const toggleSearch = document.getElementById('btn-toggle-search');
  if (toggleSearch && searchWrap && searchInput) {
    toggleSearch.onclick = () => {
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
    const catSelect = document.getElementById('sel-pos-category');
    if (catSelect) catSelect.onchange = filterCatalog;
  }

  // Customizer Modal
  const modalCust = document.getElementById('modal-item-customizer');
  const closeCust = document.getElementById('btn-close-customizer');
  if (closeCust && modalCust) {
    closeCust.onclick = () => modalCust.classList.add('hidden');
  }

  const qtyMinus = document.getElementById('btn-qty-minus');
  const qtyPlus = document.getElementById('btn-qty-plus');
  if (qtyMinus && qtyPlus) {
    qtyMinus.onclick = () => {
      const inp = document.getElementById('inp-custom-qty');
      inp.value = Math.max(1, parseFloat(inp.value || 1) - 1);
    };
    qtyPlus.onclick = () => {
      const inp = document.getElementById('inp-custom-qty');
      inp.value = parseFloat(inp.value || 1) + 1;
    };
  }

  const discFixed = document.getElementById('btn-disc-mode-fixed');
  const discPct = document.getElementById('btn-disc-mode-pct');
  if (discFixed && discPct) {
    discFixed.onclick = () => {
      customDiscountMode = 'fixed';
      discFixed.style.background = 'var(--primary-teal-light)';
      discPct.style.background = '#f1f5f9';
    };
    discPct.onclick = () => {
      customDiscountMode = 'pct';
      discPct.style.background = 'var(--primary-teal-light)';
      discFixed.style.background = '#f1f5f9';
    };
  }

  const confirmAdd = document.getElementById('btn-confirm-item-add');
  if (confirmAdd && modalCust) {
    confirmAdd.onclick = () => {
      if (!currentCustomizingProduct) return;
      const qty = parseFloat(document.getElementById('inp-custom-qty').value) || 1;
      const price = parseFloat(document.getElementById('inp-custom-price').value) || 0;
      const disc = parseFloat(document.getElementById('inp-custom-discount').value) || 0;
      const remark = document.getElementById('inp-custom-remark').value.trim();

      Cart.addItem(currentCustomizingProduct, qty, price, disc, customDiscountMode, remark);
      modalCust.classList.add('hidden');
    };
  }

  // Customer Selector Modal
  const modalCustList = document.getElementById('modal-customer');
  const openCust = document.getElementById('btn-open-customer-modal');
  const closeCustList = document.getElementById('btn-close-customer');
  if (openCust && modalCustList && closeCustList) {
    openCust.onclick = () => {
      modalCustList.classList.remove('hidden');
      renderCustomerList();
    };
    closeCustList.onclick = () => modalCustList.classList.add('hidden');
  }

  // Tender Checkout Modal
  const modalTender = document.getElementById('modal-tender');
  const chargeBtn = document.getElementById('btn-charge-ticket');
  const closeTender = document.getElementById('btn-close-tender');
  if (chargeBtn && modalTender && closeTender) {
    chargeBtn.onclick = () => {
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
    closeTender.onclick = () => modalTender.classList.add('hidden');
  }

  const paySelect = document.getElementById('tender-payment-method');
  const cashFields = document.getElementById('tender-cash-fields');
  const refFields = document.getElementById('tender-ref-fields');
  const cashPaidInput = document.getElementById('inp-tender-cash-paid');

  if (paySelect && cashFields && refFields) {
    paySelect.onchange = () => {
      if (paySelect.value === 'cash') {
        cashFields.classList.remove('hidden');
        refFields.classList.add('hidden');
      } else {
        cashFields.classList.add('hidden');
        refFields.classList.remove('hidden');
      }
    };
  }

  if (cashPaidInput) {
    cashPaidInput.oninput = () => {
      const paid = parseFloat(cashPaidInput.value) || 0;
      const total = Cart.getTotals().grandTotal;
      document.getElementById('lbl-tender-change').textContent = Math.max(0, paid - total).toFixed(2);
    };
  }

  const commitTender = document.getElementById('btn-commit-tender');
  if (commitTender) {
    commitTender.onclick = async () => await commitSaleTransaction();
  }
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
      <button type="button" class="btn-outline-blue" style="height:32px; font-size:0.75rem; width:auto; padding:0 12px;">SELECT</button>
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
    await IDB.saveOfflineOrder(orderPayload);
  }

  alert(`Sale committed successfully! Receipt: ${receiptNo}`);
  document.getElementById('modal-tender').classList.add('hidden');
  Cart.clearTicket(false);
    }
