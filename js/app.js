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

document.addEventListener('DOMContentLoaded', async () => {
  Router.init();

  bindNavigationEvents();
  bindAuthFlows();
  bindTerminalActions();
  bindDrawerModules();
  bindLiveSyncEvents();

  if (window.lucide) window.lucide.createIcons();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(console.warn);
  }

  try {
    await IDB.init();
  } catch (err) {
    console.warn('[IDB] Warning:', err);
  }

  const statusPill = document.getElementById('connection-status-pill');
  SyncEngine.init((isOnline) => {
    if (statusPill) statusPill.style.display = isOnline ? 'none' : 'block';
  });
  if (statusPill) statusPill.style.display = navigator.onLine ? 'none' : 'block';

  try {
    const session = await Auth.syncSession();
    if (session?.user) {
      bootTerminal();
    } else {
      Router.navigate('splash', false);
    }
  } catch (err) {
    Router.navigate('splash', false);
  }
});

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

  document.getElementById('btn-goto-register').onclick = (e) => {
    e.preventDefault();
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

  // Merge exact quantities from cached_inventory if available
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
    const price = Number(rawPrice).toFixed(2);
    const stock = item.stock_quantity ?? item.stock ?? null;
    const initials = (item.name || 'QS').slice(0, 2).toUpperCase();

    return `
      <div class="product-list-row" data-id="${item.id}">
        <div class="product-row-left">
          <div class="product-row-circle">${initials}</div>
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
// Customer Management & Creation (+ ADD NEW CUSTOMER)
// =========================================================================
function bindCustomerModalActions() {
  const modalCustList = document.getElementById('modal-customer');
  const modalAddCust = document.getElementById('modal-add-customer');

  // Open "Add Customer" Form
  document.getElementById('btn-show-add-customer').onclick = () => {
    document.getElementById('cust-code').value = 'CUST-' + Math.floor(1000 + Math.random() * 9000);
    modalAddCust.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ root: modalAddCust });
  };

  document.getElementById('btn-close-add-customer').onclick = () => {
    modalAddCust.classList.add('hidden');
  };

  // Submit New Customer
  document.getElementById('btn-save-customer').onclick = async (e) => {
    e.preventDefault();
    const firstName = document.getElementById('cust-firstname').value.trim();
    const lastName = document.getElementById('cust-lastname').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();

    if (!firstName || !phone) {
      alert('First name and phone number are required.');
      return;
    }

    const nowIso = new Date().toISOString();
    const newCust = {
      id: crypto.randomUUID(),
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
      loyalty_points: 0,
      outstanding_balance: 0,
      created_at: nowIso,
      updated_at: nowIso
    };

    try {
      if (navigator.onLine && supabase) {
        const { error } = await supabase.from('customers').insert([newCust]);
        if (error) throw error;
      } else {
        await IDB.queueOutbox('CREATE_CUSTOMER', newCust);
      }
      await IDB.putItem('cached_customers', newCust);
      alert('Customer saved successfully!');
      modalAddCust.classList.add('hidden');
      renderCustomerList();
    } catch (err) {
      console.warn('[Customer] Online insert failed, buffered to outbox:', err);
      await IDB.queueOutbox('CREATE_CUSTOMER', newCust);
      await IDB.putItem('cached_customers', newCust);
      alert('Customer cached locally and will sync to backoffice.');
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
      <button type="button" class="btn-outline-blue" style="height:32px; font-size:0.75rem; width:auto; padding:0 14px;">SELECT</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-cust-id]').forEach((row) => {
    row.onclick = () => {
      const cust = customers.find((c) => c.id === row.dataset.custId);
      Cart.selectedCustomer = cust;
      alert(`Customer '${cust.name}' attached to current ticket.`);
      document.getElementById('modal-customer').classList.add('hidden');
    };
  });
}

// =========================================================================
// Drawer Modules (Sales, Products, Inventory, Settings)
// =========================================================================
function bindDrawerModules() {
  const drawer = document.getElementById('side-drawer');
  const backdrop = document.getElementById('drawer-backdrop');

  const closeDrawer = () => {
    drawer.classList.remove('active');
    backdrop.classList.remove('active');
  };

  // Drawer Route Clicks
  document.querySelectorAll('.drawer-link[data-nav]').forEach((link) => {
    link.onclick = (e) => {
      e.preventDefault();
      closeDrawer();
      const target = link.dataset.nav;

      if (target === 'pos') Router.navigate('pos');
      else if (target === 'sales') {
        Router.navigate('sales');
        loadPastReceipts();
      }
      else if (target === 'products') {
        Router.navigate('products');
        loadProductCatalogManagement();
      }
      else if (target === 'inventory') {
        Router.navigate('inventory');
        populateInventoryDropdowns();
      }
      else if (target === 'settings') Router.navigate('settings');
    };
  });

  // Manage Sales Sub-Tabs
  bindTabSwitching('data-sales-tab', 'tab-sales-');
  // Products Sub-Tabs
  bindTabSwitching('data-prod-tab', 'tab-prod-');
  // Inventory Sub-Tabs
  bindTabSwitching('data-inv-tab', 'tab-inv-');
  // Settings Sub-Tabs
  bindTabSwitching('data-settings-tab', 'tab-settings-');

  // Cash In / Cash Out Actions
  document.getElementById('btn-save-cash-action').onclick = async () => {
    const actionType = document.getElementById('cash-action-type').value;
    const amount = parseFloat(document.getElementById('inp-cash-action-amount').value) || 0;
    const note = document.getElementById('inp-cash-action-note').value.trim();

    if (amount <= 0) return alert('Enter a valid amount.');

    const payload = {
      id: crypto.randomUUID(),
      shop_id: Auth.currentShop?.id,
      cashier_id: Auth.currentUser?.id,
      action_type: actionType,
      amount: amount,
      note: note,
      created_at: new Date().toISOString()
    };

    try {
      if (navigator.onLine && supabase) {
        await supabase.from('cash_transactions').insert([payload]);
      } else {
        await IDB.queueOutbox('CASH_TRANSACTION', payload);
      }
    } catch (e) {
      await IDB.queueOutbox('CASH_TRANSACTION', payload);
    }

    await IDB.putItem('cash_shifts', payload);
    alert(`Cash ${actionType.toUpperCase()} of KES ${amount.toFixed(2)} recorded!`);
    document.getElementById('inp-cash-action-amount').value = '';
    document.getElementById('inp-cash-action-note').value = '';
  };

  // Add Product Form
  const modalAddProd = document.getElementById('modal-add-product');
  document.getElementById('btn-add-product-trigger').onclick = () => {
    const sel = document.getElementById('prod-category-select');
    sel.innerHTML = categoriesList.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    modalAddProd.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ root: modalAddProd });
  };
  document.getElementById('btn-close-add-product').onclick = () => modalAddProd.classList.add('hidden');

  document.getElementById('btn-save-new-product').onclick = async (e) => {
    e.preventDefault();
    const name = document.getElementById('prod-name').value.trim();
    const price = parseFloat(document.getElementById('prod-retail-price').value) || 0;
    if (!name || price <= 0) return alert('Valid product name and price required.');

    const nowIso = new Date().toISOString();
    const newProd = {
      id: crypto.randomUUID(),
      shop_id: Auth.currentShop?.id,
      name: name,
      category_id: document.getElementById('prod-category-select').value || null,
      retail_price: price,
      cost_price: parseFloat(document.getElementById('prod-cost-price').value) || 0,
      sku: document.getElementById('prod-sku').value.trim() || null,
      stock_quantity: parseFloat(document.getElementById('prod-initial-stock').value) || 0,
      is_active: true,
      created_at: nowIso,
      updated_at: nowIso
    };

    try {
      if (navigator.onLine && supabase) {
        await supabase.from('products').insert([newProd]);
        // Also seed inventory row
        await supabase.from('inventory').insert([{
          shop_id: newProd.shop_id,
          product_id: newProd.id,
          quantity_on_hand: newProd.stock_quantity,
          min_stock_level: 5.00
        }]);
      } else {
        await IDB.queueOutbox('CREATE_PRODUCT', newProd);
      }
    } catch (err) {
      await IDB.queueOutbox('CREATE_PRODUCT', newProd);
    }

    await IDB.putItem('cached_catalog', newProd);
    alert('Product added successfully!');
    modalAddProd.classList.add('hidden');
    await loadCatalogData();
    loadProductCatalogManagement();
  };

  // Add Category Modal / Prompt
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
    alert('Category created!');
    await loadCatalogData();
    loadProductCatalogManagement();
  };

  // Inventory: GRN (Goods Received Note)
  document.getElementById('btn-commit-grn').onclick = async () => {
    const pId = document.getElementById('grn-product-select').value;
    const qty = parseFloat(document.getElementById('grn-qty').value) || 0;
    const cost = parseFloat(document.getElementById('grn-unit-cost').value) || 0;
    const ref = document.getElementById('grn-supplier-ref').value.trim();

    if (!pId || qty <= 0) return alert('Select product and enter positive quantity.');

    const log = {
      id: crypto.randomUUID(),
      shop_id: Auth.currentShop?.id,
      product_id: pId,
      transaction_type: 'GRN',
      quantity: qty,
      unit_cost: cost,
      reference: ref,
      created_at: new Date().toISOString()
    };

    try {
      if (navigator.onLine && supabase) {
        await supabase.from('inventory_transactions').insert([log]);
        // Increment inventory
        const { data: curInv } = await supabase.from('inventory').select('quantity_on_hand').eq('product_id', pId).single();
        const curQty = curInv ? parseFloat(curInv.quantity_on_hand) || 0 : 0;
        await supabase.from('inventory').upsert([{
          shop_id: log.shop_id,
          product_id: pId,
          quantity_on_hand: curQty + qty,
          updated_at: new Date().toISOString()
        }], { onConflict: 'product_id' });
      } else {
        await IDB.queueOutbox('INVENTORY_LOG', log);
      }
    } catch (e) {
      await IDB.queueOutbox('INVENTORY_LOG', log);
    }

    await IDB.putItem('inventory_logs', log);
    alert(`GRN committed: +${qty} units added to stock!`);
    document.getElementById('grn-qty').value = '';
    await loadCatalogData();
  };

  // Inventory: SA (Stock Adjustment)
  document.getElementById('btn-commit-sa').onclick = async () => {
    const pId = document.getElementById('sa-product-select').value;
    const saType = document.getElementById('sa-type').value;
    const qty = parseFloat(document.getElementById('sa-qty').value) || 0;
    const reason = document.getElementById('sa-reason').value.trim();

    if (!pId || qty === 0) return alert('Select product and valid adjustment quantity.');

    const log = {
      id: crypto.randomUUID(),
      shop_id: Auth.currentShop?.id,
      product_id: pId,
      transaction_type: `SA_${saType.toUpperCase()}`,
      quantity: qty,
      reference: reason,
      created_at: new Date().toISOString()
    };

    try {
      if (navigator.onLine && supabase) {
        await supabase.from('inventory_transactions').insert([log]);
      } else {
        await IDB.queueOutbox('INVENTORY_LOG', log);
      }
    } catch (e) {
      await IDB.queueOutbox('INVENTORY_LOG', log);
    }

    await IDB.putItem('inventory_logs', log);
    alert('Stock adjustment recorded!');
    document.getElementById('sa-qty').value = '';
    await loadCatalogData();
  };

  // Inventory: TOG (Transfer of Goods)
  document.getElementById('btn-commit-tog').onclick = async () => {
    const dest = document.getElementById('tog-destination-branch').value.trim();
    const pId = document.getElementById('tog-product-select').value;
    const qty = parseFloat(document.getElementById('tog-qty').value) || 0;
    const note = document.getElementById('tog-note').value.trim();

    if (!dest || !pId || qty <= 0) return alert('Destination and transfer quantity required.');

    const log = {
      id: crypto.randomUUID(),
      source_shop_id: Auth.currentShop?.id,
      destination_shop: dest,
      product_id: pId,
      quantity: qty,
      note: note,
      status: 'dispatched',
      created_at: new Date().toISOString()
    };

    try {
      if (navigator.onLine && supabase) {
        await supabase.from('stock_transfers').insert([log]);
      } else {
        await IDB.queueOutbox('STOCK_TRANSFER', log);
      }
    } catch (e) {
      await IDB.queueOutbox('STOCK_TRANSFER', log);
    }

    await IDB.putItem('inventory_logs', log);
    alert(`Transfer dispatched to ${dest}!`);
    document.getElementById('tog-qty').value = '';
  };

  // Settings: Software & Printers
  document.getElementById('btn-save-software-settings').onclick = () => {
    const cur = document.getElementById('set-currency').value.trim() || 'KES';
    const wake = document.getElementById('set-wakelock').value;
    if (wake === 'enabled' && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(console.warn);
    }
    alert(`Preferences saved! Base Currency: ${cur}`);
  };

  document.getElementById('btn-save-printer-settings').onclick = () => {
    alert('Printer configuration stored successfully.');
  };

  document.getElementById('btn-test-print').onclick = () => {
    window.print();
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

async function loadPastReceipts() {
  const container = document.getElementById('receipts-list-container');
  if (navigator.onLine && supabase && Auth.currentShop?.id) {
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('shop_id', Auth.currentShop.id)
      .order('created_at', { ascending: false })
      .limit(25);

    if (data && data.length) {
      container.innerHTML = data.map((r) => `
        <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>${r.receipt_no}</strong>
            <div style="font-size:0.75rem; color:var(--text-muted);">${new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <strong style="color:var(--primary-teal-dark);">${Number(r.total).toFixed(2)} KES</strong>
        </div>
      `).join('');
      return;
    }
  }

  // Fallback to local receipts
  const localReceipts = await IDB.getReceipts();
  if (localReceipts && localReceipts.length) {
    container.innerHTML = localReceipts.slice(-25).reverse().map((r) => `
      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <strong>${r.receipt_no}</strong>
          <div style="font-size:0.75rem; color:var(--text-muted);">${new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (Offline)</div>
        </div>
        <strong style="color:var(--primary-teal-dark);">${Number(r.total).toFixed(2)} KES</strong>
      </div>
    `).join('');
    return;
  }

  container.innerHTML = `<p style="text-align:center; padding:30px; color:var(--text-muted);">No sales recorded today.</p>`;
}

async function loadProductCatalogManagement() {
  const pList = document.getElementById('products-catalog-list');
  const cList = document.getElementById('categories-catalog-list');

  const products = await IDB.getCatalog();
  const categories = await IDB.getCategories();

  pList.innerHTML = products.map((p) => `
    <div class="product-list-row">
      <div>
        <strong>${p.name}</strong>
        <div style="font-size:0.75rem; color:var(--text-muted);">Stock: ${p.stock_quantity ?? 0}</div>
      </div>
      <strong>${Number(p.retail_price).toFixed(2)} KES</strong>
    </div>
  `).join('');

  cList.innerHTML = categories.map((c) => `
    <div style="padding:12px; border-bottom:1px solid #e2e8f0; font-weight:600;">
      ${c.name}
    </div>
  `).join('');
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
      if (confirm('Log out of QuickSell POS?')) await Auth.signOut();
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
      if (!overflow.classList.contains('hidden')) {
        if (!overflow.contains(e.target) && e.target !== openOverflow) {
          overflow.classList.add('hidden');
        }
      }
    });
  }

  const optClear = document.getElementById('opt-clear-cart');
  if (optClear) {
    optClear.onclick = (e) => {
      e.preventDefault();
      if (confirm('Clear current ticket items?')) {
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

  // Ticket Discount Tag Button
  const ticketDiscBtn = document.getElementById('btn-apply-ticket-discount');
  if (ticketDiscBtn) {
    ticketDiscBtn.onclick = (e) => {
      e.preventDefault();
      const curDiscount = Cart.ticketDiscount || 0;
      const entered = prompt('Enter order discount amount (in KES):', curDiscount > 0 ? curDiscount : '');
      if (entered !== null) {
        Cart.setTicketDiscount(entered);
      }
    };
  }

  // Search Toggle
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

  // Customizer Modal
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

  const discFixed = document.getElementById('btn-disc-mode-fixed');
  const discPct = document.getElementById('btn-disc-mode-pct');
  if (discFixed && discPct) {
    discFixed.onclick = (e) => {
      e.preventDefault();
      customDiscountMode = 'fixed';
      discFixed.style.background = 'var(--primary-teal-light)';
      discFixed.style.color = 'var(--primary-teal-dark)';
      discPct.style.background = '#f1f5f9';
      discPct.style.color = 'var(--text-main)';
    };
    discPct.onclick = (e) => {
      e.preventDefault();
      customDiscountMode = 'pct';
      discPct.style.background = 'var(--primary-teal-light)';
      discPct.style.color = 'var(--primary-teal-dark)';
      discFixed.style.background = '#f1f5f9';
      discFixed.style.color = 'var(--text-main)';
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

  // Customer Selector Modal & Add Customer Actions
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

  // Tender Checkout Modal
  const modalTender = document.getElementById('modal-tender');
  const chargeBtn = document.getElementById('btn-charge-ticket');
  const closeTender = document.getElementById('btn-close-tender');
  if (chargeBtn && modalTender && closeTender) {
    chargeBtn.onclick = (e) => {
      e.preventDefault();
      if (!Cart.items.length) {
        alert('Your ticket is empty. Tap an item to add it to the ticket.');
        return;
      }
      const totals = Cart.getTotals();
      document.getElementById('tender-grand-total').textContent = totals.grandTotal.toFixed(2);
      document.getElementById('inp-tender-cash-paid').value = totals.grandTotal.toFixed(2);
      document.getElementById('lbl-tender-change').textContent = '0.00';
      modalTender.classList.remove('hidden');
    };
    closeTender.onclick = (e) => {
      e.preventDefault();
      modalTender.classList.add('hidden');
    };
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
    commitTender.onclick = async (e) => {
      e.preventDefault();
      await commitSaleTransaction();
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
  const discFixed = document.getElementById('btn-disc-mode-fixed');
  const discPct = document.getElementById('btn-disc-mode-pct');
  if (discFixed && discPct) {
    discPct.style.background = 'var(--primary-teal-light)';
    discPct.style.color = 'var(--primary-teal-dark)';
    discFixed.style.background = '#f1f5f9';
    discFixed.style.color = 'var(--text-main)';
  }

  modal.classList.remove('hidden');
}

async function syncEverything() {
  if (!navigator.onLine) {
    alert('Device is currently offline. Connect to the internet to sync catalog and orders.');
    return;
  }

  try {
    await Auth.refreshLocalCatalog(Auth.currentShop?.id);
    await loadCatalogData();
    await SyncEngine.syncPendingData();
    alert('Catalog and pending sales synchronized successfully.');
  } catch (err) {
    alert('Sync encountered an issue: ' + err.message);
  }
}

// =========================================================================
// Authentication Execution
// =========================================================================
function bindAuthFlows() {
  const wireToggle = (btnId, inpId) => {
    const btn = document.getElementById(btnId);
    const inp = document.getElementById(inpId);
    if (btn && inp) {
      btn.onclick = (e) => {
        e.preventDefault();
        inp.type = inp.type === 'password' ? 'text' : 'password';
      };
    }
  };
  wireToggle('toggle-pwd-login', 'login-password');
  wireToggle('toggle-pwd-reg', 'reg-password');

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
// Commit Sale Transaction
// =========================================================================
async function commitSaleTransaction() {
  const commitBtn = document.getElementById('btn-commit-tender');
  commitBtn.disabled = true;
  commitBtn.textContent = 'PROCESSING...';

  const totals = Cart.getTotals();
  const paymentMethod = document.getElementById('tender-payment-method').value;
  const refCode = document.getElementById('inp-tender-ref-code').value.trim();
  const receiptNo = `QS-M-${Date.now().toString().slice(-7)}`;
  const orderId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const orderPayload = {
    id: orderId,
    shop_id: Auth.currentShop?.id,
    cashier_id: Auth.currentUser?.id,
    customer_id: Cart.selectedCustomer?.id || null,
    shift_id: null,
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

  const paymentsPayload = [{
    id: crypto.randomUUID(),
    order_id: orderId,
    payment_method: paymentMethod,
    amount: totals.grandTotal,
    reference_no: refCode || null,
    reference_code: refCode || null,
    created_at: nowIso,
  }];

  const fullOrder = {
    ...orderPayload,
    items: itemsPayload,
    payments: paymentsPayload
  };

  // 1. Decrement stock in IndexedDB immediately for instant offline UI update
  for (const item of itemsPayload) {
    await IDB.decrementLocalStock(item.product_id, item.quantity);
  }

  // 2. Commit transaction
  try {
    let pushedOnline = false;

    if (navigator.onLine && supabase) {
      const { error: rpcErr } = await supabase.rpc('process_pos_sale', {
        p_order: orderPayload,
        p_items: itemsPayload,
        p_payments: paymentsPayload
      });

      if (!rpcErr) {
        pushedOnline = true;
      } else {
        console.warn('[Sale] RPC failed, trying fallback tables:', rpcErr.message);
        // Fallback directly to tables if RPC encounters an issue
        const { error: orderErr } = await supabase.from('orders').insert([orderPayload]);
        if (!orderErr) {
          if (itemsPayload.length) await supabase.from('order_items').insert(itemsPayload);
          if (paymentsPayload.length) await supabase.from('payments').insert(paymentsPayload);
          pushedOnline = true;
        }
      }
    }

    if (!pushedOnline) {
      await IDB.saveOfflineOrder(fullOrder);
    }

    // Save copy to local receipt cache
    await IDB.saveReceipt(fullOrder);

    alert(`Sale completed! Receipt No: ${receiptNo}`);
    document.getElementById('modal-tender').classList.add('hidden');
    Cart.clearTicket(false);
    await loadCatalogData();
  } catch (err) {
    console.warn('Network transaction write failed, queued locally:', err);
    await IDB.saveOfflineOrder(fullOrder);
    await IDB.saveReceipt(fullOrder);
    alert(`Network unavailable. Sale queued locally! Receipt No: ${receiptNo}`);
    document.getElementById('modal-tender').classList.add('hidden');
    Cart.clearTicket(false);
    await loadCatalogData();
  } finally {
    commitBtn.disabled = false;
    commitBtn.textContent = 'COMPLETE SALE';
  }
}