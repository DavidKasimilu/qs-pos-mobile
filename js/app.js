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
let isMultiSelectMode = false;
let selectedBatchIds = new Set();
let pinEntryBuffer = '';
let appPinCode = localStorage.getItem('qs_pos_app_pin') || null;

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
    const session = await Auth.syncSession();
    if (session?.user) {
      if (appPinCode) {
        lockTerminalPin();
      } else {
        bootTerminal();
      }
    } else {
      Router.navigate('splash', false);
    }
  } catch (err) {
    Router.navigate('splash', false);
  }
});

// =========================================================================
// Security PIN & Screen Lock Management
// =========================================================================
function bindSecurityPinPad() {
  const pinDots = document.querySelectorAll('.pin-dot');
  
  const updatePinDots = () => {
    pinDots.forEach((dot, idx) => {
      if (idx < pinEntryBuffer.length) {
        dot.classList.add('filled');
      } else {
        dot.classList.remove('filled');
      }
    });
  };

  document.querySelectorAll('.pin-key-btn[data-key]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      if (pinEntryBuffer.length < 4) {
        pinEntryBuffer += btn.dataset.key;
        updatePinDots();
        if (pinEntryBuffer.length === 4) {
          setTimeout(verifyPinCode, 100);
        }
      }
    };
  });

  const btnClear = document.getElementById('btn-pin-clear');
  if (btnClear) {
    btnClear.onclick = () => {
      pinEntryBuffer = '';
      updatePinDots();
    };
  }

  const btnBack = document.getElementById('btn-pin-backspace');
  if (btnBack) {
    btnBack.onclick = () => {
      pinEntryBuffer = pinEntryBuffer.slice(0, -1);
      updatePinDots();
    };
  }
}

function verifyPinCode() {
  if (pinEntryBuffer === appPinCode) {
    pinEntryBuffer = '';
    document.querySelectorAll('.pin-dot').forEach((d) => d.classList.remove('filled'));
    document.getElementById('screen-pin-lock').classList.add('hidden');
    bootTerminal();
  } else {
    alert('Incorrect Security PIN. Please try again.');
    pinEntryBuffer = '';
    document.querySelectorAll('.pin-dot').forEach((d) => d.classList.remove('filled'));
  }
}

function lockTerminalPin() {
  pinEntryBuffer = '';
  document.querySelectorAll('.pin-dot').forEach((d) => d.classList.remove('filled'));
  document.getElementById('screen-pin-lock').classList.remove('hidden');
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
      alert('First name and phone number are required.');
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
      alert(editId ? 'Customer updated!' : 'Customer saved!');
      modalAddCust.classList.add('hidden');
      renderCustomerList();
    } catch (err) {
      console.warn('[Customer] Operation buffered:', err);
      await IDB.queueOutbox(editId ? 'UPDATE_CUSTOMER' : 'CREATE_CUSTOMER', custObj);
      await IDB.putItem('cached_customers', custObj);
      alert('Customer saved locally and queued for sync.');
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
      alert(`Customer '${cust.name}' attached to current ticket.`);
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
      if (confirm(`Are you sure you want to delete customer '${c.name}'?`)) {
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
        alert('Customer deleted.');
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

  bindTabSwitching('data-sales-tab', 'tab-sales-');
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
      if (!selectedBatchIds.size) return alert('No items selected.');
      if (confirm(`Are you sure you want to delete ${selectedBatchIds.size} selected item(s)?`)) {
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
        alert('Selected items deleted.');
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
    if (!name || price <= 0) return alert('Valid product name and price required.');

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
    alert(editId ? 'Product updated successfully!' : 'Product added successfully!');
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
    alert('Category created!');
    await loadCatalogData();
    loadProductCatalogManagement();
  };

  // Settings & Security PIN Handlers
  document.getElementById('btn-save-software-settings').onclick = () => {
    const cur = document.getElementById('set-currency').value.trim() || 'KES';
    const wake = document.getElementById('set-wakelock').value;
    if (wake === 'enabled' && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(console.warn);
    }
    alert(`Preferences saved! Base Currency: ${cur}`);
  };

  document.getElementById('btn-save-pin-settings').onclick = () => {
    const isEnabled = document.getElementById('set-pin-enabled').value === 'enabled';
    const pinCode = document.getElementById('set-pin-code').value.trim();

    if (isEnabled) {
      if (!/^\d{4}$/.test(pinCode)) {
        return alert('Security PIN must be exactly 4 numeric digits.');
      }
      appPinCode = pinCode;
      localStorage.setItem('qs_pos_app_pin', appPinCode);
      alert('Security PIN enabled successfully!');
    } else {
      appPinCode = null;
      localStorage.removeItem('qs_pos_app_pin');
      alert('Security PIN disabled.');
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

  pList.innerHTML = products.map((p) => {
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
            <div style="font-size:0.75rem; color:var(--text-muted);">Stock: ${p.stock_quantity ?? 0} | ${Number(p.retail_price).toFixed(2)} KES</div>
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

  cList.innerHTML = categories.map((c) => `
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
      if (confirm(`Delete product '${p.name}'?`)) {
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
        alert('Product deleted.');
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
      alert('Category updated.');
      await loadCatalogData();
      loadProductCatalogManagement();
    };
  });

  // Delete Category
  cList.querySelectorAll('.btn-del-category').forEach((btn) => {
    btn.onclick = async () => {
      const c = categories.find((cat) => cat.id === btn.dataset.id);
      if (!c) return;
      if (confirm(`Delete category '${c.name}'?`)) {
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
        alert('Category deleted.');
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
      if (!overflow.classList.contains('hidden') && !overflow.contains(e.target) && e.target !== openOverflow) {
        overflow.classList.add('hidden');
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

  const optLock = document.getElementById('opt-lock-terminal');
  if (optLock) {
    optLock.onclick = (e) => {
      e.preventDefault();
      if (overflow) overflow.classList.add('hidden');
      lockTerminalPin();
    };
  }

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
      const country = regCountrySelect?.value || 'Kenya';

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

  for (const item of itemsPayload) {
    await IDB.decrementLocalStock(item.product_id, item.quantity);
  }

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

    await IDB.saveReceipt(fullOrder);

    alert(`Sale completed! Receipt No: ${receiptNo}`);
    document.getElementById('modal-tender').classList.add('hidden');
    Cart.clearTicket(false);
    await loadCatalogData();
  } catch (err) {
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