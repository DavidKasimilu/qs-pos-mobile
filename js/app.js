import { IDB } from './idb.js';
import { SyncEngine } from './sync.js';
import { CONFIG } from './config.js';
import { Router } from './router.js';
import { Auth, supabase } from './auth.js';
import { Cart } from './cart.js';
import { Shift, showNotice } from './shift.js';
import { Currency } from './currency.js';
import { Prefs, Device } from './prefs.js';
import { printReceipt, printTestReceipt } from './receipt.js';
import { Checkout } from './checkout.js';
import { openShareDialog } from './share.js';
import { UI } from './ui.js';
import { StaffCache } from './staff-cache.js';

let pendingEmail = '';
let currentCustomizingProduct = null;
let customDiscountMode = 'pct';
let catalogSearchQuery = '';
let productsList = [];
let categoriesList = [];
let isMultiSelectMode = false;
let selectedBatchIds = new Set();
let pinEntryBuffer = '';
// "Lock terminal" signs the current person out and shows the dial pad. A cashier or staff member unlocks it with
// their own 4-digit PIN (checked on the server, stored hashed). Managers and admins have no PIN: they use Exit.
const LOCK_FLAG = 'qs_pos_locked';
const getStoredShop = () => { try { return JSON.parse(localStorage.getItem('qs_pos_shop') || 'null'); } catch (e) { return null; } };
let lockBusy = false;
function removeBootCover() { document.getElementById('boot-cover')?.remove(); }

document.addEventListener('DOMContentLoaded', async () => {
  Router.init();

  bindNavigationEvents();
  bindAuthFlows();
  bindTerminalActions();
  bindDrawerModules();
  bindLiveSyncEvents();
  bindImageUploader();
  bindSecurityPinPad();

  if (window.lucide) window.lucide.createIcons();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(console.warn);
  }

  try {
    await IDB.init();
  } catch (err) {
    console.warn('[IDB] Warning:', err);
  }

  const updateOnlineStatus = (isOnline) => {
    const statusPill = document.getElementById('connection-status-pill');
    const offlineIcon = document.getElementById('appbar-offline-icon');
    if (statusPill) statusPill.style.display = isOnline ? 'none' : 'block';
    if (offlineIcon) offlineIcon.style.display = isOnline ? 'none' : 'inline-flex';
  };

  SyncEngine.init(updateOnlineStatus);
  updateOnlineStatus(navigator.onLine);

  try {
    if (localStorage.getItem(LOCK_FLAG) === '1') {
      if (getStoredShop()?.id) {
        Auth.syncSession().catch(() => {});   // keep syncing offline sales in the background while locked
        showPinLock();
        return;
      }
      localStorage.removeItem(LOCK_FLAG);   // the device no longer knows its store: use the normal sign-in
    }
    const session = await Auth.syncSession();
    if (session?.user) bootTerminal();
    else Router.navigate('splash', false);
  } catch (err) {
    Router.navigate('splash', false);
  } finally {
    removeBootCover();
  }
});

// =========================================================================
// Security PIN & Screen Lock Management
// =========================================================================
function updatePinDots() {
  document.querySelectorAll('.pin-dot').forEach((dot, idx) => dot.classList.toggle('filled', idx < pinEntryBuffer.length));
}

function resetPinEntry() {
  pinEntryBuffer = '';
  updatePinDots();
}

function bindSecurityPinPad() {
  document.querySelectorAll('.pin-key-btn[data-key]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      if (lockBusy || pinEntryBuffer.length >= 4) return;
      pinEntryBuffer += btn.dataset.key;
      updatePinDots();
      if (pinEntryBuffer.length === 4) setTimeout(verifyPinCode, 120);
    };
  });

  const btnClear = document.getElementById('btn-pin-clear');
  if (btnClear) btnClear.onclick = () => { if (!lockBusy) resetPinEntry(); };

  const btnBack = document.getElementById('btn-pin-backspace');
  if (btnBack) btnBack.onclick = () => { if (lockBusy) return; pinEntryBuffer = pinEntryBuffer.slice(0, -1); updatePinDots(); };

  // 3-dot menu on the lock screen: Exit -> the main sign-in screen
  const menu = document.getElementById('lock-menu');
  document.getElementById('btn-lock-menu').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
  document.addEventListener('click', () => menu.classList.add('hidden'));
  document.getElementById('btn-lock-exit').onclick = async () => {
    menu.classList.add('hidden');
    let note = '';
    try {
      const pending = await IDB.getPendingOrders();
      if (pending.length) note = `\n\n${pending.length} sale(s) made offline have not synced yet. They stay on this device and sync after you sign in again.`;
    } catch (e) { /* ignore */ }
    if (!(await UI.confirm(`Exit to the main sign-in screen? This signs out of this device.${note}`, { okLabel: 'Exit' }))) return;
    await Auth.signOut();   // clears the lock and reloads into the sign-in screen
  };
}

async function verifyPinCode() {
  if (lockBusy) return;
  const pin = pinEntryBuffer;
  const shop = getStoredShop();
  if (pin.length !== 4) return;
  if (!shop?.id) {
    await Auth.signOut();
    return;
  }
  lockBusy = true;
  try {
    await Auth.unlockWithPin(shop.id, pin);     // online: server check; offline: this device's saved PINs
    localStorage.removeItem(LOCK_FLAG);
    window.location.reload();                   // start fresh as this person (the cover hides the reload)
  } catch (err) {
    resetPinEntry();
    const wrap = document.getElementById('pin-dots-wrap');
    wrap.classList.remove('shake'); void wrap.offsetWidth; wrap.classList.add('shake');
    Device.warn();
    lockBusy = false;
    await UI.alert(err.message || 'Incorrect PIN. Please try again.');
  }
}

async function lockTerminal() {
  if (!getStoredShop()?.id) {
    await UI.alert('This device does not know its store yet. Please log out and sign in again.');
    return;
  }
  if (Cart.items.length && !(await UI.confirm('Locking the terminal clears the current ticket. Continue?'))) return;

  // show the dial pad straight away; nothing else flashes
  localStorage.setItem(LOCK_FLAG, '1');
  document.getElementById('side-drawer')?.classList.remove('active');
  document.getElementById('drawer-backdrop')?.classList.remove('active');
  showPinLock();

  // the saved login stays on the device so offline sales keep syncing; only the screen is locked
  try { Cart.clearTicket(false); } catch (e) { /* ignore */ }
  try { Shift.stop(); } catch (e) { /* ignore */ }
}

function showPinLock() {
  resetPinEntry();
  document.getElementById('lock-shop-name').textContent = getStoredShop()?.name || '';
  document.getElementById('screen-pin-lock').classList.remove('hidden');
}

// Staff can only sell and look at sales activity; everything else in the menu is greyed out.
function isStaffRole() {
  return String(Auth.currentProfile?.role || '').toLowerCase() === 'staff';
}

function applyRoleAccess() {
  const staff = isStaffRole();
  document.querySelectorAll('#side-drawer .drawer-link').forEach((link) => {
    const allowed = !staff || ['pos', 'sales'].includes(link.dataset.nav) || link.id === 'btn-drawer-logout';
    link.classList.toggle('drawer-disabled', !allowed);
    link.disabled = !allowed;
  });
  const logoutLabel = document.querySelector('#btn-drawer-logout span');
  if (logoutLabel) logoutLabel.textContent = staff ? 'Lock Terminal' : 'Log Out';
  // staff do not see Cash management in Manage Sales
  document.querySelector('#sales-title-menu [data-sales-tab="cash"]')?.classList.toggle('hidden', staff);
}

// =========================================================================
// Product Image Uploading (Supabase Storage)
// =========================================================================
function bindImageUploader() {
  const fileInput = document.getElementById('file-prod-image');
  const previewThumb = document.getElementById('img-preview-thumb');
  const placeholder = document.getElementById('img-preview-placeholder');
  const existingUrlInput = document.getElementById('prod-existing-image-url');

  if (fileInput) {
    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          previewThumb.src = event.target.result;
          previewThumb.classList.remove('hidden');
          if (placeholder) placeholder.classList.add('hidden');
        };
        reader.readAsDataURL(file);
      }
    };
  }
}

async function uploadProductImage(file, productId) {
  if (!file || !supabase) return null;

  try {
    const ext = file.name.split('.').pop();
    const filePath = `${Auth.currentShop?.id || 'shop'}/${productId}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from('product-images')
      .upload(filePath, file, { upsert: true });

    if (uploadErr) throw uploadErr;

    const { data: publicUrlData } = supabase.storage
      .from('product-images')
      .getPublicUrl(filePath);

    return publicUrlData?.publicUrl || null;
  } catch (err) {
    console.warn('[Image Upload] Exception uploading to Supabase Storage:', err);
    return null;
  }
}

// =========================================================================
// Real-time Event Subscriptions (Web Back-Office <-> Mobile POS)
// =========================================================================
function bindLiveSyncEvents() {
  window.addEventListener('catalog-updated', async () => {
    await loadCatalogData();
    const activeScreen = document.querySelector('.screen:not(.hidden)');
    if (activeScreen && activeScreen.id === 'screen-products') {
      loadProductCatalogManagement();
    }
  });

  window.addEventListener('inventory-updated', async () => {
    await loadCatalogData();
    const activeScreen = document.querySelector('.screen:not(.hidden)');
    if (activeScreen && activeScreen.id === 'screen-inventory') {
      populateInventoryDropdowns();
    }
  });

  window.addEventListener('customers-updated', () => {
    const modalCust = document.getElementById('modal-customer');
    if (modalCust && !modalCust.classList.contains('hidden')) {
      const searchCustInput = document.getElementById('inp-search-customer');
      renderCustomerList(searchCustInput ? searchCustInput.value.toLowerCase().trim() : '');
    }
  });
}

// =========================================================================
// Navigation & Transition Handlers
// =========================================================================
function bindNavigationEvents() {
  document.getElementById('btn-goto-signin').onclick = (e) => {
    e.preventDefault();
    Router.navigate('signin');
  };

  const splashMenu = document.getElementById('splash-menu');
  document.getElementById('btn-splash-menu').onclick = (e) => { e.stopPropagation(); splashMenu.classList.toggle('hidden'); };
  document.addEventListener('click', () => splashMenu.classList.add('hidden'));
  document.getElementById('btn-goto-register').onclick = (e) => {
    e.preventDefault();
    splashMenu.classList.add('hidden');
    Router.navigate('register');
  };

  document.querySelectorAll('.btn-back-splash').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      Router.navigate('splash');
    };
  });

  document.querySelectorAll('.btn-back-signin').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      Router.navigate('signin');
    };
  });

  document.querySelectorAll('.btn-back-pos').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      Router.navigate('pos');
    };
  });

  const backOtp = document.getElementById('btn-back-otp');
  if (backOtp) {
    backOtp.onclick = (e) => {
      e.preventDefault();
      Router.navigate('register');
    };
  }
}

function bootTerminal() {
  const shop = Auth.currentShop;
  // this device now knows its store, so the lock screen can sign cashiers and staff in with their PIN
  if (shop?.id) localStorage.setItem('qs_pos_shop', JSON.stringify({ id: shop.id, name: shop.name || '' }));
  Cart.init(shop?.id);

  Currency.applyLabels();
  Device.initGlobal();
  loadSettingsControls();
  Device.applyWakeLock();

  const roleEl = document.getElementById('drawer-user-role');
  const roleName = String(Auth.currentProfile?.role || 'cashier');
  const firstName = String(Auth.currentProfile?.full_name || '').trim().split(/\s+/)[0];
  if (roleEl) roleEl.textContent = firstName || roleName.toUpperCase();
  const devEl = document.getElementById('drawer-device-id');
  if (devEl) {
    if (!devEl.dataset.base) devEl.dataset.base = devEl.textContent.trim();
    devEl.textContent = `${roleName.charAt(0).toUpperCase()}${roleName.slice(1).toLowerCase()} \u00b7 ${devEl.dataset.base}`;
  }

  const shopEl = document.getElementById('drawer-shop-name');
  if (shopEl) shopEl.textContent = shop?.name || 'QuickSell Terminal';

  Router.navigate('pos');
  loadCatalogData();
  Shift.start();   // checks the shop's shift; asks to start one when none is open
  applyRoleAccess();
  setTimeout(applyRoleAccess, 400);   // the Shift menu entry is added a moment later
}

async function loadCatalogData() {
  const catSelect = document.getElementById('sel-pos-category');
  productsList = await IDB.getCatalog();
  categoriesList = await IDB.getCategories();
  const inventoryList = await IDB.getInventory();

  if (!productsList.length && navigator.onLine && Auth.currentShop?.id) {
    await Auth.refreshLocalCatalog(Auth.currentShop.id);
    productsList = await IDB.getCatalog();
    categoriesList = await IDB.getCategories();
  }

  if (inventoryList && inventoryList.length) {
    const invMap = new Map(inventoryList.map((i) => [i.product_id, i.quantity_on_hand]));
    productsList = productsList.map((p) => ({
      ...p,
      stock_quantity: invMap.has(p.id) ? invMap.get(p.id) : (p.stock_quantity ?? 0)
    }));
  }

  if (catSelect) {
    catSelect.innerHTML = `<option value="all">All Items</option>` +
      categoriesList.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  renderProductRows(productsList);
  populateInventoryDropdowns();
}

function renderProductRows(items) {
  const container = document.getElementById('pos-items-container');
  if (!container) return;

  if (!items || !items.length) {
    container.innerHTML = `
      <div style="padding:48px 24px; text-align:center; color:var(--text-muted);">
        <i data-lucide="package-open" style="width:40px; height:40px; margin:0 auto 12px; display:block; opacity:0.4;"></i>
        <p style="font-size:0.95rem; font-weight:600;">No items found</p>
        <p style="font-size:0.8rem; margin-top:4px;">Use Manage Catalog to add products.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons({ root: container });
    return;
  }

  container.innerHTML = items.map((item) => {
    const rawPrice = item.retail_price ?? item.price ?? 0;
    const price = fmtMoney(rawPrice);
    const stock = item.stock_quantity ?? item.stock ?? null;
    const initials = (item.name || 'QS').slice(0, 2).toUpperCase();

    const mediaHtml = item.image_url 
      ? `<img src="${item.image_url}" alt="${item.name}" class="product-row-image" onerror="this.outerHTML='<div class=\\'product-row-circle\\'>${initials}</div>'" />`
      : `<div class="product-row-circle">${initials}</div>`;

    return `
      <div class="product-list-row" data-id="${item.id}">
        <div class="product-row-left">
          ${mediaHtml}
          <div>
            <div style="font-weight:700; font-size:0.95rem; color:var(--text-main);">${item.name || 'Unnamed Item'}</div>
            <div style="font-size:0.75rem; color:var(--text-muted);">
              ${stock !== null ? `${stock} In Stock` : (item.sku ? `SKU: ${item.sku}` : 'Standard Item')}
            </div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-weight:700; font-size:0.95rem; color:var(--primary-teal-dark);">${price}</span>
          <i data-lucide="info" style="width:18px; height:18px; color:var(--text-muted);"></i>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) window.lucide.createIcons({ root: container });

  container.querySelectorAll('.product-list-row').forEach((row) => {
    row.onclick = () => {
      const found = items.find((p) => p.id === row.dataset.id);
      if (found) openItemCustomizer(found);
    };
  });
}

// =========================================================================
// Customer Management (Add, Edit, Delete)
// =========================================================================
function bindCustomerModalActions() {
  const modalAddCust = document.getElementById('modal-add-customer');

  document.getElementById('btn-show-add-customer').onclick = () => {
    document.getElementById('cust-edit-id').value = '';
    document.getElementById('lbl-modal-customer-title').textContent = 'Add New Customer';
    document.getElementById('cust-code').value = 'CUST-' + Math.floor(1000 + Math.random() * 9000);
    document.getElementById('cust-firstname').value = '';
    document.getElementById('cust-lastname').value = '';
    document.getElementById('cust-email').value = '';
    document.getElementById('cust-phone').value = '';
    document.getElementById('cust-address').value = '';
    document.getElementById('cust-city').value = '';
    document.getElementById('cust-region').value = '';
    document.getElementById('cust-postal').value = '';
    modalAddCust.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ root: modalAddCust });
  };

  document.getElementById('btn-close-add-customer').onclick = () => {
    modalAddCust.classList.add('hidden');
  };

  document.getElementById('btn-save-customer').onclick = async (e) => {
    e.preventDefault();
    const editId = document.getElementById('cust-edit-id').value;
    const firstName = document.getElementById('cust-firstname').value.trim();
    const lastName = document.getElementById('cust-lastname').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();

    if (!firstName || !phone) {
      UI.alert('First name and phone number are required.');
      return;
    }

    const nowIso = new Date().toISOString();
    const custId = editId || crypto.randomUUID();

    const custObj = {
      id: custId,
      shop_id: Auth.currentShop?.id,
      customer_code: document.getElementById('cust-code').value,
      name: `${firstName} ${lastName}`.trim(),
      first_name: firstName,
      last_name: lastName,
      email: document.getElementById('cust-email').value.trim() || null,
      phone: phone,
      address: document.getElementById('cust-address').value.trim(),
      city: document.getElementById('cust-city').value.trim(),
      region: document.getElementById('cust-region').value.trim(),
      postal_code: document.getElementById('cust-postal').value.trim(),
      country: document.getElementById('cust-country').value || 'Kenya',
      updated_at: nowIso
    };

    if (!editId) {
      custObj.created_at = nowIso;
      custObj.loyalty_points = 0;
      custObj.outstanding_balance = 0;
    }

    try {
      if (navigator.onLine && supabase) {
        const { error } = await supabase.from('customers').upsert([custObj]);
        if (error) throw error;
      } else {
        await IDB.queueOutbox(editId ? 'UPDATE_CUSTOMER' : 'CREATE_CUSTOMER', custObj);
      }
      await IDB.putItem('cached_customers', custObj);
      UI.alert(editId ? 'Customer updated!' : 'Customer saved!');
      modalAddCust.classList.add('hidden');
      renderCustomerList();
    } catch (err) {
      console.warn('[Customer] Operation buffered:', err);
      await IDB.queueOutbox(editId ? 'UPDATE_CUSTOMER' : 'CREATE_CUSTOMER', custObj);
      await IDB.putItem('cached_customers', custObj);
      UI.alert('Customer saved locally and queued for sync.');
      modalAddCust.classList.add('hidden');
      renderCustomerList();
    }
  };
}

async function renderCustomerList(filterText = '') {
  const container = document.getElementById('customer-list-wrap');
  let customers = await IDB.getCustomers();

  if (filterText) {
    customers = customers.filter((c) => 
      (c.name && c.name.toLowerCase().includes(filterText)) ||
      (c.phone && c.phone.includes(filterText))
    );
  }

  if (!customers.length) {
    container.innerHTML = `<p style="padding:24px; text-align:center; color:var(--text-muted); font-size:0.85rem;">No customers found. Click + ADD NEW CUSTOMER above.</p>`;
    return;
  }

  container.innerHTML = customers.map((c) => `
    <div class="product-list-row" data-cust-id="${c.id}" style="padding:12px 0;">
      <div>
        <strong style="color:var(--text-main); font-size:0.95rem;">${c.name}</strong>
        <div style="font-size:0.75rem; color:var(--text-muted);">${c.phone || 'No phone'} | Code: ${c.customer_code || '-'}</div>
      </div>
      <div class="item-row-actions">
        <button type="button" class="btn-outline-blue btn-select-cust" data-id="${c.id}" style="height:32px; font-size:0.75rem; padding:0 12px; margin-right:4px;">SELECT</button>
        <button type="button" class="icon-touch-btn btn-edit-cust" data-id="${c.id}" aria-label="Edit Customer">
          <i data-lucide="edit-3" style="width:16px; height:16px; color:var(--primary-teal);"></i>
        </button>
        <button type="button" class="icon-touch-btn btn-del-cust" data-id="${c.id}" aria-label="Delete Customer">
          <i data-lucide="trash-2" style="width:16px; height:16px; color:var(--danger-red);"></i>
        </button>
      </div>
    </div>
  `).join('');

  if (window.lucide) window.lucide.createIcons({ root: container });

  container.querySelectorAll('.btn-select-cust').forEach((btn) => {
    btn.onclick = () => {
      const cust = customers.find((c) => c.id === btn.dataset.id);
      Cart.selectedCustomer = cust;
      UI.alert(`Customer '${cust.name}' attached to current ticket.`);
      document.getElementById('modal-customer').classList.add('hidden');
    };
  });

  container.querySelectorAll('.btn-edit-cust').forEach((btn) => {
    btn.onclick = () => {
      const c = customers.find((cust) => cust.id === btn.dataset.id);
      if (!c) return;
      document.getElementById('cust-edit-id').value = c.id;
      document.getElementById('lbl-modal-customer-title').textContent = 'Edit Customer';
      document.getElementById('cust-code').value = c.customer_code || '';
      document.getElementById('cust-firstname').value = c.first_name || c.name.split(' ')[0] || '';
      document.getElementById('cust-lastname').value = c.last_name || c.name.split(' ').slice(1).join(' ') || '';
      document.getElementById('cust-email').value = c.email || '';
      document.getElementById('cust-phone').value = c.phone || '';
      document.getElementById('cust-address').value = c.address || '';
      document.getElementById('cust-city').value = c.city || '';
      document.getElementById('cust-region').value = c.region || '';
      document.getElementById('cust-postal').value = c.postal_code || '';
      document.getElementById('cust-country').value = c.country || 'Kenya';
      document.getElementById('modal-add-customer').classList.remove('hidden');
    };
  });

  container.querySelectorAll('.btn-del-cust').forEach((btn) => {
    btn.onclick = async () => {
      const c = customers.find((cust) => cust.id === btn.dataset.id);
      if (!c) return;
      if (await UI.confirm(`Are you sure you want to delete customer '${c.name}'?`)) {
        try {
          if (navigator.onLine && supabase) {
            await supabase.from('customers').delete().eq('id', c.id);
          } else {
            await IDB.queueOutbox('DELETE_CUSTOMER', { id: c.id });
          }
        } catch (e) {
          await IDB.queueOutbox('DELETE_CUSTOMER', { id: c.id });
        }
        await IDB.removeCustomer(c.id);
        UI.alert('Customer deleted.');
        renderCustomerList();
      }
    };
  });
}

// =========================================================================
// Drawer Modules & Product/Category Management (Edit & Batch Delete)
// =========================================================================
function bindDrawerModules() {
  const drawer = document.getElementById('side-drawer');
  const backdrop = document.getElementById('drawer-backdrop');

  const closeDrawer = () => {
    drawer.classList.remove('active');
    backdrop.classList.remove('active');
  };

  document.querySelectorAll('.drawer-link[data-nav]').forEach((link) => {
    link.onclick = (e) => {
      e.preventDefault();
      closeDrawer();
      const target = link.dataset.nav;
      if (isStaffRole() && !['pos', 'sales'].includes(target)) return;

      if (target === 'pos') Router.navigate('pos');
      else if (target === 'sales') {
        Router.navigate('sales');
        loadPastReceipts();
        if (!isStaffRole()) refreshCashTab();
      }
      else if (target === 'products') {
        Router.navigate('products');
        loadProductCatalogManagement();
      }
      else if (target === 'inventory') {
        Router.navigate('inventory');
        populateInventoryDropdowns();
      }
      else if (target === 'settings') { Router.navigate('settings'); Currency.applyLabels(); loadSettingsControls(); }
    };
  });

  bindReceiptScreens();
  document.getElementById('btn-save-cash-action')?.addEventListener('click', saveCashAction);
  bindTabSwitching('data-prod-tab', 'tab-prod-');
  bindTabSwitching('data-inv-tab', 'tab-inv-');
  bindTabSwitching('data-settings-tab', 'tab-settings-');

  // Multi-Select Overflow Toggle in Catalog Top AppBar
  const catalogOverflow = document.getElementById('catalog-overflow-popup');
  const btnCatalogOverflow = document.getElementById('btn-catalog-overflow');
  if (btnCatalogOverflow && catalogOverflow) {
    btnCatalogOverflow.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      catalogOverflow.classList.toggle('hidden');
      if (window.lucide) window.lucide.createIcons({ root: catalogOverflow });
    };

    window.addEventListener('click', (e) => {
      if (!catalogOverflow.classList.contains('hidden') && !catalogOverflow.contains(e.target) && e.target !== btnCatalogOverflow) {
        catalogOverflow.classList.add('hidden');
      }
    });
  }

  const optMultiSelect = document.getElementById('opt-toggle-multi-select');
  if (optMultiSelect) {
    optMultiSelect.onclick = (e) => {
      e.preventDefault();
      catalogOverflow.classList.add('hidden');
      isMultiSelectMode = !isMultiSelectMode;
      selectedBatchIds.clear();
      document.getElementById('catalog-batch-bar').classList.toggle('hidden', !isMultiSelectMode);
      loadProductCatalogManagement();
    };
  }

  const btnBatchCancel = document.getElementById('btn-batch-cancel');
  if (btnBatchCancel) {
    btnBatchCancel.onclick = () => {
      isMultiSelectMode = false;
      selectedBatchIds.clear();
      document.getElementById('catalog-batch-bar').classList.add('hidden');
      loadProductCatalogManagement();
    };
  }

  const btnBatchDelete = document.getElementById('btn-batch-delete-confirm');
  if (btnBatchDelete) {
    btnBatchDelete.onclick = async () => {
      if (!selectedBatchIds.size) return UI.alert('No items selected.');
      if (await UI.confirm(`Are you sure you want to delete ${selectedBatchIds.size} selected item(s)?`)) {
        for (const id of selectedBatchIds) {
          try {
            if (navigator.onLine && supabase) {
              await supabase.from('products').delete().eq('id', id);
            } else {
              await IDB.queueOutbox('DELETE_PRODUCT', { id });
            }
          } catch (e) {
            await IDB.queueOutbox('DELETE_PRODUCT', { id });
          }
          await IDB.removeProduct(id);
        }
        UI.alert('Selected items deleted.');
        selectedBatchIds.clear();
        isMultiSelectMode = false;
        document.getElementById('catalog-batch-bar').classList.add('hidden');
        await loadCatalogData();
        loadProductCatalogManagement();
      }
    };
  }

  // Add / Edit Product Form Modal Trigger
  const modalAddProd = document.getElementById('modal-add-product');
  document.getElementById('btn-add-product-trigger').onclick = () => {
    document.getElementById('prod-edit-id').value = '';
    document.getElementById('lbl-modal-product-title').textContent = 'Add Product';
    document.getElementById('prod-name').value = '';
    document.getElementById('prod-retail-price').value = '';
    document.getElementById('prod-cost-price').value = '';
    document.getElementById('prod-sku').value = '';
    document.getElementById('prod-initial-stock').value = '0';
    document.getElementById('prod-existing-image-url').value = '';
    document.getElementById('img-preview-thumb').classList.add('hidden');
    document.getElementById('img-preview-placeholder').classList.remove('hidden');

    const sel = document.getElementById('prod-category-select');
    sel.innerHTML = `<option value="">No Category</option>` + categoriesList.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    modalAddProd.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ root: modalAddProd });
  };

  document.getElementById('btn-close-add-product').onclick = () => modalAddProd.classList.add('hidden');

  document.getElementById('btn-save-new-product').onclick = async (e) => {
    e.preventDefault();
    const editId = document.getElementById('prod-edit-id').value;
    const name = document.getElementById('prod-name').value.trim();
    const price = parseFloat(document.getElementById('prod-retail-price').value) || 0;
    if (!name || price <= 0) return UI.alert('Valid product name and price required.');

    const nowIso = new Date().toISOString();
    const prodId = editId || crypto.randomUUID();

    // Upload product image if selected
    const fileInput = document.getElementById('file-prod-image');
    let imageUrl = document.getElementById('prod-existing-image-url').value || null;
    if (fileInput && fileInput.files && fileInput.files[0]) {
      const uploadedUrl = await uploadProductImage(fileInput.files[0], prodId);
      if (uploadedUrl) imageUrl = uploadedUrl;
    }

    const prodObj = {
      id: prodId,
      shop_id: Auth.currentShop?.id,
      name: name,
      category_id: document.getElementById('prod-category-select').value || null,
      retail_price: price,
      cost_price: parseFloat(document.getElementById('prod-cost-price').value) || 0,
      sku: document.getElementById('prod-sku').value.trim() || null,
      stock_quantity: parseFloat(document.getElementById('prod-initial-stock').value) || 0,
      image_url: imageUrl,
      is_active: true,
      updated_at: nowIso
    };

    if (!editId) prodObj.created_at = nowIso;

    try {
      if (navigator.onLine && supabase) {
        await supabase.from('products').upsert([prodObj]);
        await supabase.from('inventory').upsert([{
          shop_id: prodObj.shop_id,
          product_id: prodObj.id,
          quantity_on_hand: prodObj.stock_quantity,
          min_stock_level: 5.00,
          updated_at: nowIso
        }], { onConflict: 'product_id' });
      } else {
        await IDB.queueOutbox(editId ? 'UPDATE_PRODUCT' : 'CREATE_PRODUCT', prodObj);
      }
    } catch (err) {
      await IDB.queueOutbox(editId ? 'UPDATE_PRODUCT' : 'CREATE_PRODUCT', prodObj);
    }

    await IDB.putItem('cached_catalog', prodObj);
    UI.alert(editId ? 'Product updated successfully!' : 'Product added successfully!');
    modalAddProd.classList.add('hidden');
    await loadCatalogData();
    loadProductCatalogManagement();
  };

  // Category Creation / Prompt
  document.getElementById('btn-add-category-trigger').onclick = async () => {
    const catName = prompt('Enter New Category Name:');
    if (!catName || !catName.trim()) return;

    const newCat = {
      id: crypto.randomUUID(),
      shop_id: Auth.currentShop?.id,
      name: catName.trim(),
      created_at: new Date().toISOString()
    };

    try {
      if (navigator.onLine && supabase) {
        await supabase.from('categories').insert([newCat]);
      } else {
        await IDB.queueOutbox('CREATE_CATEGORY', newCat);
      }
    } catch (e) {
      await IDB.queueOutbox('CREATE_CATEGORY', newCat);
    }

    await IDB.putItem('cached_categories', newCat);
    UI.alert('Category created!');
    await loadCatalogData();
    loadProductCatalogManagement();
  };

  // Settings & Security PIN Handlers
  document.getElementById('btn-save-software-settings').onclick = async () => {
    const btn = document.getElementById('btn-save-software-settings');
    const cur = document.getElementById('set-currency').value;
    Prefs.set({
      wakelock: document.getElementById('set-wakelock').value,
      haptics: document.getElementById('set-haptics').value,
    });
    Device.applyWakeLock();
    Device.tap();
    btn.disabled = true;
    try {
      if (cur !== Currency.code) {
        if (!await UI.confirm(`Change the store currency to ${cur}?\n\nExisting prices and past receipts keep their numbers; only the currency label changes. Update your prices if they were set in a different currency.`)) {
          Currency.applyLabels();
          return;
        }
        await Currency.set(cur);   // saves on the shop, then 'currency-changed' refreshes the screens
      }
      UI.alert(`Preferences saved. Currency: ${Currency.code}`);
    } catch (err) {
      Currency.applyLabels();
      UI.alert(err.message || String(err));
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('btn-save-printer-settings').onclick = () => {
    Prefs.set({
      printerType: 'system',
      paperWidth: document.getElementById('set-paper-width').value,
      autoPrint: document.getElementById('set-auto-print').value,
    });
    UI.alert('Printer settings saved.');
  };
  document.getElementById('btn-test-print').onclick = () => {
    Prefs.set({ paperWidth: document.getElementById('set-paper-width').value });
    printTestReceipt();
  };

  window.addEventListener('currency-changed', () => {
    Currency.applyLabels();
    Cart.notifyUpdate();
    loadCatalogData();
    loadProductCatalogManagement();
    loadPastReceipts();
    refreshCashTab();
  });

  // Catalog search (products tab or categories tab, whichever is open)
  const catSearchBtn = document.getElementById('btn-catalog-search');
  const catSearchWrap = document.getElementById('catalog-search-wrap');
  const catSearchInput = document.getElementById('inp-catalog-search');
  if (catSearchBtn && catSearchWrap && catSearchInput) {
    const syncPlaceholder = () => {
      const onCats = !document.getElementById('tab-prod-categories').classList.contains('hidden');
      catSearchInput.placeholder = onCats ? 'Search categories...' : 'Search products by name, SKU or barcode...';
    };
    catSearchBtn.onclick = (e) => {
      e.preventDefault();
      const opening = catSearchWrap.classList.contains('hidden');
      catSearchWrap.classList.toggle('hidden');
      if (opening) { syncPlaceholder(); catSearchInput.focus(); }
      else { catSearchInput.value = ''; catalogSearchQuery = ''; loadProductCatalogManagement(); }
    };
    catSearchInput.oninput = () => {
      catalogSearchQuery = catSearchInput.value.trim().toLowerCase();
      loadProductCatalogManagement();
    };
    document.querySelectorAll('[data-prod-tab]').forEach((b) => b.addEventListener('click', syncPlaceholder));
  }

  document.getElementById('btn-save-pin-settings').onclick = async () => {
    const isEnabled = document.getElementById('set-pin-enabled').value === 'enabled';
    const pinCode = document.getElementById('set-pin-code').value.trim();
    const role = String(Auth.currentProfile?.role || '').toLowerCase();

    if (!['cashier', 'staff'].includes(role)) {
      return UI.alert('PIN sign-in is for cashiers and staff. Administrators and managers sign in with their password.');
    }
    if (!navigator.onLine) return UI.alert('Connect to the internet to change your sign-in PIN.');

    if (isEnabled) {
      if (!/^\d{4}$/.test(pinCode)) return UI.alert('The PIN must be exactly 4 digits.');
      const { error: pinErr } = await supabase.rpc('set_my_pin', { p_pin: pinCode });
      if (pinErr) return UI.alert(pinErr.message);
      document.getElementById('set-pin-code').value = '';
      UI.alert('Sign-in PIN saved. You can now sign in with your email and this PIN.');
    } else {
      const { error: clearErr } = await supabase.rpc('clear_my_pin');
      if (clearErr) return UI.alert(clearErr.message);
      UI.alert('Sign-in PIN removed. Use your password to sign in.');
    }
  };
}

function bindTabSwitching(dataAttr, prefix) {
  document.querySelectorAll(`[${dataAttr}]`).forEach((tabBtn) => {
    tabBtn.onclick = () => {
      const parent = tabBtn.parentElement;
      parent.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.remove('active');
        b.style.color = 'var(--text-muted)';
        b.style.borderBottom = 'none';
      });
      tabBtn.classList.add('active');
      tabBtn.style.color = 'var(--primary-teal)';
      tabBtn.style.borderBottom = '2px solid var(--primary-teal)';

      const val = tabBtn.getAttribute(dataAttr);
      const root = tabBtn.closest('.screen');
      root.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
      const activeContent = document.getElementById(`${prefix}${val}`);
      if (activeContent) activeContent.classList.remove('hidden');
    };
  });
}

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let receiptCache = new Map();
let receiptRows = [];
let receiptsOffline = false;
let receiptDate = '';      // YYYY-MM-DD filter, '' = latest
let receiptQuery = '';
const employeeNames = new Map();
let currentView = null;    // { order, items, payments }

const dayLabel = (d) => d.toLocaleDateString([], { month: 'short', day: '2-digit', year: 'numeric' });

function renderReceiptList() {
  const container = document.getElementById('receipts-list-container');
  const q = receiptQuery.trim().toLowerCase().replace(/,/g, '');
  const rows = !q ? receiptRows : receiptRows.filter((r) =>
    String(r.receipt_no || '').toLowerCase().includes(q) || String(Number(r.total) || 0).includes(q) || fmtMoney(r.total).replace(/,/g, '').includes(q));

  if (!rows.length) {
    container.innerHTML = `<div class="rc-empty">${receiptRows.length ? 'No receipts match your search.' : (receiptDate ? 'No receipts on this day.' : 'No sales recorded yet.')}</div>`;
    return;
  }
  let lastDay = '';
  container.innerHTML = rows.map((r) => {
    const t = new Date(r.created_at);
    const day = dayLabel(t);
    const head = day !== lastDay ? `<div class="rc-day">${escHtml(day)}</div>` : '';
    lastDay = day;
    return `${head}
      <div class="rc-row receipt-row" data-receipt-id="${escHtml(r.id)}">
        <div class="rc-no">Receipt: ${escHtml(r.receipt_no)}${receiptsOffline ? ' (offline)' : ''}</div>
        <div class="rc-amt">${fmtMoney(r.total)}<div class="rc-time">${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div>
      </div>`;
  }).join('');
  container.querySelectorAll('.receipt-row').forEach((el) => { el.onclick = () => openReceiptView(el.dataset.receiptId); });
}

async function loadPastReceipts() {
  const container = document.getElementById('receipts-list-container');
  receiptCache = new Map();
  receiptRows = [];
  receiptsOffline = false;
  let rows = null;

  const chip = document.getElementById('receipt-date-chip');
  if (receiptDate) {
    document.getElementById('receipt-date-chip-text').textContent = dayLabel(new Date(`${receiptDate}T00:00:00`));
    chip.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
  }
  const dayStart = receiptDate ? new Date(`${receiptDate}T00:00:00`) : null;
  const dayEnd = dayStart ? new Date(dayStart.getTime() + 86400000) : null;

  if (navigator.onLine && supabase && Auth.currentShop?.id) {
    let query = supabase.from('orders').select('*').eq('shop_id', Auth.currentShop.id);
    if (dayStart) query = query.gte('created_at', dayStart.toISOString()).lt('created_at', dayEnd.toISOString());
    const { data, error } = await query.order('created_at', { ascending: false }).limit(300);
    if (!error && data) rows = data;
  }

  if (!rows) {
    const local = (await IDB.getReceipts()) || [];
    rows = local.slice().reverse().filter((r) => !dayStart || (new Date(r.created_at) >= dayStart && new Date(r.created_at) < dayEnd));
    receiptsOffline = true;
  }

  receiptRows = rows;
  rows.forEach((r) => receiptCache.set(String(r.id), r));
  renderReceiptList();
}

async function employeeName(order) {
  if (!order.cashier_id) return '';
  if (order.cashier_id === Auth.currentUser?.id && Auth.currentProfile?.full_name) return Auth.currentProfile.full_name;
  if (employeeNames.has(order.cashier_id)) return employeeNames.get(order.cashier_id);
  let name = '';
  if (navigator.onLine && supabase) {
    const { data } = await supabase.from('profiles').select('full_name').eq('id', order.cashier_id).maybeSingle();
    name = data?.full_name || '';
  }
  if (!name) name = StaffCache.nameFor(order.cashier_id);
  employeeNames.set(order.cashier_id, name);
  return name;
}

async function openReceiptView(orderId) {
  const order = receiptCache.get(String(orderId));
  if (!order) return;

  let items = Array.isArray(order.items) ? order.items : null;
  let payments = Array.isArray(order.payments) ? order.payments : null;
  if ((!items || !payments) && navigator.onLine && supabase) {
    const [it, pay] = await Promise.all([
      supabase.from('order_items').select('*').eq('order_id', order.id),
      supabase.from('payments').select('*').eq('order_id', order.id),
    ]);
    if (!it.error) items = it.data;
    if (!pay.error) payments = pay.data;
  }
  items = items || [];
  payments = payments || [];
  currentView = { order, items, payments };

  const [name, catalog] = await Promise.all([employeeName(order), IDB.getCatalog().catch(() => [])]);
  const skuById = new Map((catalog || []).map((p) => [String(p.id), p.sku]));
  const cur = escHtml(Currency.code);
  const METHOD_LABELS = { cash: 'Cash', mpesa: 'Mobile Money', card: 'Card' };
  const totalQty = items.reduce((s, i) => s + Number(i.quantity || 0), 0);

  document.getElementById('rv-title').textContent = order.receipt_no;
  document.getElementById('rv-body').innerHTML = `
    <div class="rv-total"><strong>${fmtMoney(order.total)}</strong><span>${cur}</span></div>
    <div class="rv-meta">
      <div>Receipt: ${escHtml(order.receipt_no)}</div>
      ${name ? `<div>Employee: ${escHtml(name)}</div>` : ''}
      <div>Date: ${escHtml(dayLabel(new Date(order.created_at)))} ${new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      ${order.order_status && order.order_status !== 'completed' ? `<div>Status: ${escHtml(order.order_status)}</div>` : ''}
    </div>
    <div class="rv-th"><span>Product Price</span><span>Qty</span><span>Total (${cur})</span></div>
    ${items.length ? items.map((i) => {
      const sku = skuById.get(String(i.product_id));
      return `<div class="rv-item">
        <div>${escHtml(i.product_name || 'Item')}${sku ? ` <small>- ${escHtml(sku)}</small>` : ''}</div>
        <div class="rv-line"><span>${fmtMoney(i.unit_price)}</span><span>${Number(i.quantity)}</span><span>${fmtMoney(i.total ?? Number(i.quantity) * Number(i.unit_price))}</span></div>
      </div>`;
    }).join('') : `<div class="rv-item" style="color:#6b7280;">Item details are not available for this receipt${navigator.onLine ? '.' : ' while offline.'}</div>`}
    <div class="rv-sum"><span>Subtotal</span><span>${fmtMoney(order.subtotal)}</span></div>
    ${Number(order.discount_amount) ? `<div class="rv-count"><span>Discount</span><span>-${fmtMoney(order.discount_amount)}</span></div>` : ''}
    ${Number(order.tax_amount) ? `<div class="rv-count"><span>Tax</span><span>${fmtMoney(order.tax_amount)}</span></div>` : ''}
    <div class="rv-count"><span>Product: ${items.length}</span><span>Qty: ${totalQty}</span></div>
    <div class="rv-grand"><div><span>Grand total</span><span>${fmtMoney(order.total)}</span></div></div>
    ${payments.map((p) => `<div class="rv-pay"><div>${escHtml(METHOD_LABELS[p.payment_method] || String(p.payment_method || '').toUpperCase())}${p.reference_code ? `<small>Ref: ${escHtml(p.reference_code)}</small>` : ''}</div><span>${fmtMoney(p.amount)}</span></div>`).join('')}`;

  document.getElementById('rv-menu').classList.add('hidden');
  document.getElementById('screen-receipt-view').classList.remove('hidden');
}

function bindReceiptScreens() {
  const menu = document.getElementById('rv-menu');
  document.getElementById('btn-rv-back').onclick = () => { menu.classList.add('hidden'); document.getElementById('screen-receipt-view').classList.add('hidden'); };
  document.getElementById('btn-rv-menu').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
  menu.querySelectorAll('[data-rv]').forEach((b) => {
    b.onclick = async () => {
      menu.classList.add('hidden');
      if (!currentView) return;
      const { order, items, payments } = currentView;
      if (b.dataset.rv === 'print') return printReceipt(order, items, payments);
      let email = '';
      if (b.dataset.rv === 'send') {
        const customers = await IDB.getCustomers().catch(() => []);
        email = (customers || []).find((c) => c.id === order.customer_id)?.email || '';
      }
      openShareDialog(order, items, payments, b.dataset.rv === 'send' ? { mode: 'email', email } : {});
    };
  });

  // title dropdown: Past receipts / Cash management
  const titleMenu = document.getElementById('sales-title-menu');
  document.getElementById('sales-title-btn').onclick = (e) => { e.stopPropagation(); titleMenu.classList.toggle('hidden'); };
  titleMenu.querySelectorAll('[data-sales-tab]').forEach((b) => {
    b.onclick = () => {
      const tab = b.dataset.salesTab;
      titleMenu.classList.add('hidden');
      document.getElementById('sales-title').textContent = tab === 'cash' ? 'Cash management' : 'Past receipts';
      document.getElementById('btn-receipts-date').classList.toggle('hidden', tab === 'cash');
      document.querySelectorAll('#screen-sales .tab-content').forEach((c) => c.classList.add('hidden'));
      document.getElementById(`tab-sales-${tab}`).classList.remove('hidden');
      if (tab === 'cash') refreshCashTab(); else loadPastReceipts();
    };
  });
  document.addEventListener('click', () => { menu.classList.add('hidden'); titleMenu.classList.add('hidden'); });

  // search + date
  document.getElementById('inp-receipt-search').oninput = (e) => { receiptQuery = e.target.value; renderReceiptList(); };
  const dateInput = document.getElementById('inp-receipt-date');
  document.getElementById('btn-receipts-date').onclick = () => { try { dateInput.showPicker(); } catch (err) { dateInput.click(); } };
  dateInput.onchange = () => { receiptDate = dateInput.value; loadPastReceipts(); };
  document.getElementById('btn-clear-receipt-date').onclick = () => { receiptDate = ''; dateInput.value = ''; loadPastReceipts(); };
}

// Cash Management tab: live drawer balance + cash in/out entries for the current shift
async function refreshCashTab() {
  const lbl = document.getElementById('lbl-shift-drawer-cash');
  if (!lbl) return;
  const breakdown = document.getElementById('cash-breakdown');
  const list = document.getElementById('cash-entries-list');
  const cur = Currency.code;
  Currency.applyLabels();

  await Shift.refresh();
  const s = Shift.state.shift;
  if (!s) {
    lbl.textContent = 'No shift open';
    if (breakdown) breakdown.innerHTML = 'Start a shift to record cash movements.';
    if (list) list.innerHTML = '';
    return;
  }
  const t = s.totals || {};
  const expected = t.expected_cash ?? (Number(s.opening_cash || 0) + Number(t.cash_sales || 0) + Number(t.cash_in || 0) - Number(t.cash_out || 0));
  lbl.textContent = `${fmtMoney(expected)} ${cur}`;
  if (breakdown) {
    const r = (k, v) => `<div style="display:flex; justify-content:space-between; padding:2px 0;"><span>${k}</span><span>${v}</span></div>`;
    breakdown.innerHTML =
      r('Opening cash', fmtMoney(s.opening_cash)) +
      r('Cash sales', '+ ' + fmtMoney(t.cash_sales)) +
      r('Cash in', '+ ' + fmtMoney(t.cash_in)) +
      r('Cash out', '- ' + fmtMoney(t.cash_out));
  }

  if (!list) return;
  if (!navigator.onLine || !supabase) {
    list.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">Connect to the internet to see cash entries.</p>';
    return;
  }
  const { data, error } = await supabase
    .from('cash_transactions')
    .select('*')
    .eq('shop_id', Auth.currentShop.id)
    .gte('created_at', s.opened_at)
    .order('created_at', { ascending: false });
  if (error) { list.innerHTML = `<p style="color:#b91c1c; font-size:0.85rem;">${escHtml(error.message)}</p>`; return; }
  list.innerHTML = data.length ? data.map((c) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f1f5f9;">
      <div>
        <div style="font-weight:600;">${c.action_type === 'in' ? 'Cash in' : 'Cash out'}${c.note ? ' - ' + escHtml(c.note) : ''}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      <strong style="color:${c.action_type === 'in' ? '#166534' : '#b91c1c'};">${c.action_type === 'in' ? '+' : '-'} ${fmtMoney(c.amount)}</strong>
    </div>`).join('') : '<p style="color:var(--text-muted); font-size:0.85rem;">No cash in/out recorded this shift.</p>';
}

async function saveCashAction() {
  const btn = document.getElementById('btn-save-cash-action');
  const type = document.getElementById('cash-action-type').value;
  const amountEl = document.getElementById('inp-cash-action-amount');
  const noteEl = document.getElementById('inp-cash-action-note');
  const amount = parseFloat(amountEl.value);

  if (!Shift.state.shift) return UI.alert('Start a shift before recording cash movements.');
  if (!navigator.onLine || !supabase) return UI.alert('Recording cash in/out needs an internet connection.');
  if (Number.isNaN(amount) || amount <= 0) return UI.alert('Enter an amount greater than 0.');
  if (type === 'out' && !noteEl.value.trim()) return UI.alert('Add a reason for the cash out.');

  btn.disabled = true;
  btn.textContent = 'SAVING...';
  try {
    const { error } = await supabase.from('cash_transactions').insert([{
      id: crypto.randomUUID(),
      shop_id: Auth.currentShop.id,
      cashier_id: Auth.currentUser.id,
      action_type: type,
      amount,
      note: noteEl.value.trim() || null,
      created_at: new Date().toISOString(),
    }]);
    if (error) throw error;
    amountEl.value = '';
    noteEl.value = '';
    await refreshCashTab();
  } catch (err) {
    UI.alert('Could not record cash transaction: ' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'RECORD CASH TRANSACTION';
  }
}

async function loadProductCatalogManagement() {
  const pList = document.getElementById('products-catalog-list');
  const cList = document.getElementById('categories-catalog-list');

  const products = await IDB.getCatalog();
  const categories = await IDB.getCategories();

  const q = catalogSearchQuery;
  const catName = new Map(categories.map((c) => [c.id, String(c.name || '').toLowerCase()]));
  const shownProducts = !q ? products : products.filter((p) =>
    [p.name, p.sku, p.barcode, catName.get(p.category_id)].some((v) => String(v || '').toLowerCase().includes(q)));
  const shownCategories = !q ? categories : categories.filter((c) => String(c.name || '').toLowerCase().includes(q));

  pList.innerHTML = (q && !shownProducts.length) ? '<p style="padding:24px; text-align:center; color:var(--text-muted);">No products match your search.</p>' : shownProducts.map((p) => {
    const isChecked = selectedBatchIds.has(p.id) ? 'checked' : '';
    const checkboxHtml = isMultiSelectMode 
      ? `<input type="checkbox" class="batch-checkbox" data-id="${p.id}" ${isChecked} />` 
      : '';

    return `
      <div class="product-list-row" style="padding:12px 16px;">
        <div style="display:flex; align-items:center;">
          ${checkboxHtml}
          <div>
            <strong>${p.name}</strong>
            <div style="font-size:0.75rem; color:var(--text-muted);">Stock: ${p.stock_quantity ?? 0} | ${fmtMoney(p.retail_price)} ${escHtml(Currency.code)}</div>
          </div>
        </div>
        <div class="item-row-actions">
          <button type="button" class="icon-touch-btn btn-edit-product" data-id="${p.id}" aria-label="Edit Product">
            <i data-lucide="edit-3" style="width:16px; height:16px; color:var(--primary-teal);"></i>
          </button>
          <button type="button" class="icon-touch-btn btn-del-product" data-id="${p.id}" aria-label="Delete Product">
            <i data-lucide="trash-2" style="width:16px; height:16px; color:var(--danger-red);"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  cList.innerHTML = (q && !shownCategories.length) ? '<p style="padding:16px; text-align:center; color:var(--text-muted);">No categories match your search.</p>' : shownCategories.map((c) => `
    <div style="padding:12px; border-bottom:1px solid #e2e8f0; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
      <span>${c.name}</span>
      <div class="item-row-actions">
        <button type="button" class="icon-touch-btn btn-edit-category" data-id="${c.id}" aria-label="Edit Category">
          <i data-lucide="edit-3" style="width:16px; height:16px; color:var(--primary-teal);"></i>
        </button>
        <button type="button" class="icon-touch-btn btn-del-category" data-id="${c.id}" aria-label="Delete Category">
          <i data-lucide="trash-2" style="width:16px; height:16px; color:var(--danger-red);"></i>
        </button>
      </div>
    </div>
  `).join('');

  if (window.lucide) window.lucide.createIcons({ root: pList });
  if (window.lucide) window.lucide.createIcons({ root: cList });

  // Bind batch checkboxes
  pList.querySelectorAll('.batch-checkbox').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) selectedBatchIds.add(cb.dataset.id);
      else selectedBatchIds.delete(cb.dataset.id);
      const countLbl = document.getElementById('lbl-batch-count');
      if (countLbl) countLbl.textContent = `${selectedBatchIds.size} Selected`;
    };
  });

  // Edit Product
  pList.querySelectorAll('.btn-edit-product').forEach((btn) => {
    btn.onclick = () => {
      const p = products.find((item) => item.id === btn.dataset.id);
      if (!p) return;
      document.getElementById('prod-edit-id').value = p.id;
      document.getElementById('lbl-modal-product-title').textContent = 'Edit Product';
      document.getElementById('prod-name').value = p.name || '';
      document.getElementById('prod-retail-price').value = p.retail_price ?? p.price ?? 0;
      document.getElementById('prod-cost-price').value = p.cost_price ?? 0;
      document.getElementById('prod-sku').value = p.sku || '';
      document.getElementById('prod-initial-stock').value = p.stock_quantity ?? 0;
      document.getElementById('prod-existing-image-url').value = p.image_url || '';

      const thumb = document.getElementById('img-preview-thumb');
      const placeholder = document.getElementById('img-preview-placeholder');
      if (p.image_url) {
        thumb.src = p.image_url;
        thumb.classList.remove('hidden');
        if (placeholder) placeholder.classList.add('hidden');
      } else {
        thumb.classList.add('hidden');
        if (placeholder) placeholder.classList.remove('hidden');
      }

      const sel = document.getElementById('prod-category-select');
      sel.innerHTML = `<option value="">No Category</option>` + categories.map((c) => 
        `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${c.name}</option>`
      ).join('');

      document.getElementById('modal-add-product').classList.remove('hidden');
    };
  });

  // Delete Product
  pList.querySelectorAll('.btn-del-product').forEach((btn) => {
    btn.onclick = async () => {
      const p = products.find((item) => item.id === btn.dataset.id);
      if (!p) return;
      if (await UI.confirm(`Delete product '${p.name}'?`)) {
        try {
          if (navigator.onLine && supabase) {
            await supabase.from('products').delete().eq('id', p.id);
          } else {
            await IDB.queueOutbox('DELETE_PRODUCT', { id: p.id });
          }
        } catch (e) {
          await IDB.queueOutbox('DELETE_PRODUCT', { id: p.id });
        }
        await IDB.removeProduct(p.id);
        UI.alert('Product deleted.');
        await loadCatalogData();
        loadProductCatalogManagement();
      }
    };
  });

  // Edit Category
  cList.querySelectorAll('.btn-edit-category').forEach((btn) => {
    btn.onclick = async () => {
      const c = categories.find((cat) => cat.id === btn.dataset.id);
      if (!c) return;
      const newName = prompt('Edit Category Name:', c.name);
      if (!newName || !newName.trim()) return;

      const updated = { ...c, name: newName.trim(), updated_at: new Date().toISOString() };
      try {
        if (navigator.onLine && supabase) {
          await supabase.from('categories').upsert([updated]);
        } else {
          await IDB.queueOutbox('UPDATE_CATEGORY', updated);
        }
      } catch (e) {
        await IDB.queueOutbox('UPDATE_CATEGORY', updated);
      }
      await IDB.upsertCategory(updated);
      UI.alert('Category updated.');
      await loadCatalogData();
      loadProductCatalogManagement();
    };
  });

  // Delete Category
  cList.querySelectorAll('.btn-del-category').forEach((btn) => {
    btn.onclick = async () => {
      const c = categories.find((cat) => cat.id === btn.dataset.id);
      if (!c) return;
      if (await UI.confirm(`Delete category '${c.name}'?`)) {
        try {
          if (navigator.onLine && supabase) {
            await supabase.from('categories').delete().eq('id', c.id);
          } else {
            await IDB.queueOutbox('DELETE_CATEGORY', { id: c.id });
          }
        } catch (e) {
          await IDB.queueOutbox('DELETE_CATEGORY', { id: c.id });
        }
        await IDB.removeCategory(c.id);
        UI.alert('Category deleted.');
        await loadCatalogData();
        loadProductCatalogManagement();
      }
    };
  });
}

function populateInventoryDropdowns() {
  const items = productsList;
  const grnSel = document.getElementById('grn-product-select');
  const saSel = document.getElementById('sa-product-select');
  const togSel = document.getElementById('tog-product-select');

  const opts = items.map((i) => `<option value="${i.id}">${i.name} (Cur: ${i.stock_quantity ?? 0})</option>`).join('');
  if (grnSel) grnSel.innerHTML = opts;
  if (saSel) saSel.innerHTML = opts;
  if (togSel) togSel.innerHTML = opts;
}
// =========================================================================
// Terminal Operations (Customizer, Search, Drawer & Tender)
// =========================================================================
function bindTerminalActions() {
  const drawer = document.getElementById('side-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const openDrawer = document.getElementById('btn-open-drawer');

  if (openDrawer && drawer && backdrop) {
    openDrawer.onclick = (e) => {
      e.preventDefault();
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
    backOfficeLink.onclick = (e) => {
      e.preventDefault();
      window.open(CONFIG.BACKOFFICE_URL, '_blank');
    };
  }

  const logoutBtn = document.getElementById('btn-drawer-logout');
  if (logoutBtn) {
    logoutBtn.onclick = async (e) => {
      e.preventDefault();
      if (isStaffRole()) { lockTerminal(); return; }
      if (await UI.confirm('Log out of QuickSell POS?')) await Auth.signOut();
    };
  }

  // 3-Dot Overflow Menu
  const overflow = document.getElementById('overflow-popup');
  const openOverflow = document.getElementById('btn-open-overflow');
  if (openOverflow && overflow) {
    openOverflow.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      overflow.classList.toggle('hidden');
      if (window.lucide) window.lucide.createIcons({ root: overflow });
    };

    window.addEventListener('click', (e) => {
      if (!overflow.classList.contains('hidden') && !overflow.contains(e.target) && e.target !== openOverflow) {
        overflow.classList.add('hidden');
      }
    });
  }

  const optClear = document.getElementById('opt-clear-cart');
  if (optClear) {
    optClear.onclick = async (e) => {
      e.preventDefault();
      if (await UI.confirm('Clear current ticket items?')) {
        Cart.clearTicket(true);
        if (overflow) overflow.classList.add('hidden');
      }
    };
  }

  const optSync = document.getElementById('opt-trigger-sync');
  if (optSync) {
    optSync.onclick = async (e) => {
      e.preventDefault();
      if (overflow) overflow.classList.add('hidden');
      await syncEverything();
    };
  }

  const drawerLock = document.getElementById('btn-drawer-lock');
  if (drawerLock) {
    drawerLock.onclick = (e) => {
      e.preventDefault();
      document.getElementById('side-drawer')?.classList.remove('active');
      document.getElementById('drawer-backdrop')?.classList.remove('active');
      lockTerminal();
    };
  }
  window.addEventListener('qs:lock-terminal', () => lockTerminal());

  const ticketDiscBtn = document.getElementById('btn-apply-ticket-discount');
  if (ticketDiscBtn) {
    ticketDiscBtn.onclick = (e) => {
      e.preventDefault();
      const curDiscount = Cart.ticketDiscount || 0;
      const entered = prompt('Enter order discount amount:', curDiscount > 0 ? curDiscount : '');
      if (entered !== null) {
        Cart.setTicketDiscount(entered);
      }
    };
  }

  const searchWrap = document.getElementById('search-input-wrap');
  const searchInput = document.getElementById('inp-pos-search');
  const toggleSearch = document.getElementById('btn-toggle-search');
  if (toggleSearch && searchWrap && searchInput) {
    toggleSearch.onclick = (e) => {
      e.preventDefault();
      searchWrap.classList.toggle('hidden');
      if (!searchWrap.classList.contains('hidden')) searchInput.focus();
    };

    const filterCatalog = () => {
      const term = searchInput.value.toLowerCase().trim();
      const cat = document.getElementById('sel-pos-category').value;
      const filtered = productsList.filter((p) => {
        const matchCat = cat === 'all' || p.category_id === cat;
        const matchText = !term || 
          (p.name && p.name.toLowerCase().includes(term)) || 
          (p.barcode && p.barcode.toLowerCase().includes(term)) ||
          (p.sku && p.sku.toLowerCase().includes(term));
        return matchCat && matchText;
      });
      renderProductRows(filtered);
    };

    searchInput.oninput = filterCatalog;
    const catSelect = document.getElementById('sel-pos-category');
    if (catSelect) catSelect.onchange = filterCatalog;
  }

  const modalCust = document.getElementById('modal-item-customizer');
  const closeCust = document.getElementById('btn-close-customizer');
  if (closeCust && modalCust) {
    closeCust.onclick = (e) => {
      e.preventDefault();
      modalCust.classList.add('hidden');
    };
  }

  const qtyMinus = document.getElementById('btn-qty-minus');
  const qtyPlus = document.getElementById('btn-qty-plus');
  if (qtyMinus && qtyPlus) {
    qtyMinus.onclick = (e) => {
      e.preventDefault();
      const inp = document.getElementById('inp-custom-qty');
      inp.value = Math.max(1, (parseFloat(inp.value) || 1) - 1);
    };
    qtyPlus.onclick = (e) => {
      e.preventDefault();
      const inp = document.getElementById('inp-custom-qty');
      inp.value = (parseFloat(inp.value) || 1) + 1;
    };
  }

  const confirmAdd = document.getElementById('btn-confirm-item-add');
  if (confirmAdd && modalCust) {
    confirmAdd.onclick = (e) => {
      e.preventDefault();
      if (!currentCustomizingProduct) return;
      const qty = parseFloat(document.getElementById('inp-custom-qty').value) || 1;
      const price = parseFloat(document.getElementById('inp-custom-price').value) || 0;
      const disc = parseFloat(document.getElementById('inp-custom-discount').value) || 0;
      const remark = document.getElementById('inp-custom-remark').value.trim();

      Cart.addItem(currentCustomizingProduct, qty, price, disc, customDiscountMode, remark);
      modalCust.classList.add('hidden');
    };
  }

  const modalCustList = document.getElementById('modal-customer');
  const openCust = document.getElementById('btn-open-customer-modal');
  const closeCustList = document.getElementById('btn-close-customer');
  if (openCust && modalCustList && closeCustList) {
    openCust.onclick = (e) => {
      e.preventDefault();
      modalCustList.classList.remove('hidden');
      renderCustomerList();
    };
    closeCustList.onclick = (e) => {
      e.preventDefault();
      modalCustList.classList.add('hidden');
    };
  }

  const searchCustInput = document.getElementById('inp-search-customer');
  if (searchCustInput) {
    searchCustInput.oninput = () => {
      const query = searchCustInput.value.toLowerCase().trim();
      renderCustomerList(query);
    };
  }

  bindCustomerModalActions();

  const chargeBtn = document.getElementById('btn-charge-ticket');
  Checkout.init({
    commit: (payments) => commitSaleTransaction(payments),
    onNewSale: () => { /* ticket was cleared when the sale was recorded */ },
  });
  if (chargeBtn) {
    chargeBtn.onclick = (e) => {
      e.preventDefault();
      if (!Shift.allowsSales()) {
        window.dispatchEvent(new CustomEvent('qs:need-shift'));
        UI.alert('Start a shift before making sales.');
        return;
      }
      if (!Cart.items.length) {
        UI.alert('Your ticket is empty. Tap an item to add it to the ticket.');
        return;
      }
      Checkout.open();
    };
  }
}

function openItemCustomizer(product) {
  currentCustomizingProduct = product;
  const modal = document.getElementById('modal-item-customizer');
  const rawPrice = product.retail_price ?? product.price ?? 0;

  document.getElementById('customizer-item-name').textContent = product.name || 'Custom Item';
  document.getElementById('inp-custom-price').value = Number(rawPrice).toFixed(2);
  document.getElementById('inp-custom-qty').value = 1;
  document.getElementById('inp-custom-discount').value = '0.00';
  document.getElementById('inp-custom-remark').value = '';

  customDiscountMode = 'pct';
  modal.classList.remove('hidden');
}

async function syncEverything() {
  if (!navigator.onLine) {
    UI.alert('Device is currently offline. Connect to the internet to sync catalog and orders.');
    return;
  }

  try {
    await Auth.refreshLocalCatalog(Auth.currentShop?.id);
    await loadCatalogData();
    await SyncEngine.syncPendingData();
    UI.alert('Catalog and pending sales synchronized successfully.');
  } catch (err) {
    UI.alert('Sync encountered an issue: ' + err.message);
  }
}

// =========================================================================
// Authentication Execution & Dynamic Country Selection
// =========================================================================
function bindAuthFlows() {
  const regCountrySelect = document.getElementById('reg-country');
  if (regCountrySelect) {
    regCountrySelect.onchange = () => {
      const selected = regCountrySelect.options[regCountrySelect.selectedIndex];
      const flag = selected.dataset.flag || '🇰🇪';
      const code = selected.dataset.code || '+254';
      
      const flagLbl = document.getElementById('lbl-reg-flag');
      const phoneInp = document.getElementById('reg-phone');

      if (flagLbl) flagLbl.textContent = flag;
      if (phoneInp) phoneInp.placeholder = `${code} 7...`;
    };
  }

  const formLogin = document.getElementById('form-mobile-login');
  if (formLogin) {
    const emailEl = document.getElementById('login-email');
    const lastEmail = localStorage.getItem('qs_pos_last_email');   // never the password
    if (lastEmail) emailEl.value = lastEmail;

    formLogin.onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-submit-login');
      if (btn.disabled) return;
      const email = emailEl.value.trim();
      const pwd = document.getElementById('login-password').value;
      if (!email) return UI.alert('Enter your email.');
      if (!pwd) return UI.alert('Enter your password.');

      btn.disabled = true;
      btn.textContent = 'SIGNING IN...';
      try {
        await Auth.signIn(email, pwd);
        localStorage.setItem('qs_pos_last_email', email);
        localStorage.removeItem(LOCK_FLAG);
        document.getElementById('login-password').value = '';
        bootTerminal();
      } catch (err) {
        UI.alert(err.message || 'Sign-in failed.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'SIGN IN';
      }
    };
  }

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
      const country = regCountrySelect?.value || 'Kenya';

      try {
        await Auth.signUp(email, password, fullName, bizName, bizType, phone, country);
        pendingEmail = email;
        const targetEmailEl = document.getElementById('lbl-otp-target-email');
        if (targetEmailEl) targetEmailEl.textContent = email;
        Router.navigate('otp');
      } catch (err) {
        UI.alert(err.message || 'Registration failed.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'SUBMIT';
      }
    };
  }
}

// =========================================================================
// Commit Sale Transaction
// =========================================================================
function loadSettingsControls() {
  const p = Prefs.get();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('set-wakelock', p.wakelock);
  set('set-haptics', p.haptics);
  set('set-printer-type', 'system');
  set('set-paper-width', p.paperWidth);
  set('set-auto-print', p.autoPrint);
}

// Records the sale. `payments` = [{ method, amount, ref }] (one entry, or several for a split payment).
// Returns { order, synced } on success, or null when the sale was refused (the checkout screen stays open).
async function commitSaleTransaction(payments) {
  if (!Shift.allowsSales()) {
    window.dispatchEvent(new CustomEvent('qs:need-shift'));
    UI.alert('Start a shift before making sales.');
    return null;
  }

  const totals = Cart.getTotals();
  const receiptNo = `QS-M-${Date.now().toString().slice(-7)}`;
  const orderId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const orderPayload = {
    id: orderId,
    shop_id: Auth.currentShop?.id,
    cashier_id: Auth.currentUser?.id,
    customer_id: Cart.selectedCustomer?.id || null,
    shift_id: Shift.state.shift?.id || null,
    receipt_no: receiptNo,
    subtotal: totals.subtotal,
    discount_amount: totals.discountAmount,
    tax_amount: totals.taxAmount,
    total: totals.grandTotal,
    order_status: 'completed',
    service_type: 'walk_in',
    synced_from_offline: !navigator.onLine,
    offline_created_at: !navigator.onLine ? nowIso : null,
    created_at: nowIso,
  };

  const itemsPayload = Cart.items.map((i) => ({
    id: crypto.randomUUID(),
    order_id: orderId,
    product_id: i.id,
    product_name: i.name,
    quantity: i.quantity,
    unit_price: i.unitPrice,
    cost_price: i.costPrice || 0,
    tax_rate: 0,
    discount_amount: 0,
    total: i.total,
  }));

  const parts = (payments && payments.length ? payments : [{ method: 'cash', amount: totals.grandTotal, ref: '' }])
    .map((p) => ({ method: p.method, amount: Number(p.amount) || 0, ref: (p.ref || '').trim() }));
  // keep the payments adding up exactly to the order total (cents rounding)
  const diff = Math.round((totals.grandTotal - parts.reduce((s, p) => s + p.amount, 0)) * 100) / 100;
  if (diff !== 0) parts[parts.length - 1].amount = Math.round((parts[parts.length - 1].amount + diff) * 100) / 100;

  const paymentsPayload = parts.map((p) => ({
    id: crypto.randomUUID(),
    order_id: orderId,
    payment_method: p.method,
    amount: p.amount,
    reference_no: p.ref || null,
    reference_code: p.ref || null,
    created_at: nowIso,
  }));

  const fullOrder = {
    ...orderPayload,
    items: itemsPayload,
    payments: paymentsPayload
  };

  for (const item of itemsPayload) {
    await IDB.decrementLocalStock(item.product_id, item.quantity);
  }

  let pushedOnline = false;
  try {
    let refusedMessage = null;

    if (navigator.onLine && supabase) {
      const { error: rpcErr } = await SyncEngine.processSale(orderPayload, itemsPayload, paymentsPayload);

      if (!rpcErr) {
        pushedOnline = true;
      } else if (/^(P0001|42501|22|23)/.test(String(rpcErr.code || ''))) {
        // The server REFUSED the sale (no shift, shift closed, wrong store...). Never bypass that with direct inserts.
        refusedMessage = rpcErr.message;
      } else {
        const { error: orderErr } = await supabase.from('orders').insert([orderPayload]);
        if (!orderErr) {
          if (itemsPayload.length) await supabase.from('order_items').insert(itemsPayload);
          if (paymentsPayload.length) await supabase.from('payments').insert(paymentsPayload);
          pushedOnline = true;
        }
      }
    }

    if (refusedMessage) {
      // put the local stock back (it was reduced optimistically), refresh the shift and keep the ticket for a retry
      try { if (Auth.currentShop?.id) await Auth.refreshLocalCatalog(Auth.currentShop.id); } catch (e) { /* ignore */ }
      await loadCatalogData();
      await Shift.refresh();
      Device.warn();
      UI.alert(`Sale not completed: ${refusedMessage}`);
      return null;
    }

    if (!pushedOnline) {
      await IDB.saveOfflineOrder(fullOrder);
    }
  } catch (err) {
    await IDB.saveOfflineOrder(fullOrder);
    pushedOnline = false;
  }

  await IDB.saveReceipt(fullOrder);
  Cart.clearTicket(false);
  await loadCatalogData();
  return { order: fullOrder, synced: pushedOnline };
}