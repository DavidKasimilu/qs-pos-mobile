import { IDB } from './idb.js';
import { SyncEngine } from './sync.js';
import { CONFIG } from './config.js';
import { Router } from './router.js';

let activeCart = [];
let currentItemCustomizing = null;

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Initialize View Router
  Router.init();
  if (window.lucide) window.lucide.createIcons();

  // 2. Initialize IndexedDB
  try {
    await IDB.init();
  } catch (err) {
    console.warn('IDB init error:', err);
  }

  // 3. Register Service Worker with clean relative path
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => console.log('[PWA] Service Worker registered in scope:', reg.scope))
      .catch((err) => console.warn('[PWA] Service Worker registration failed:', err));
  }

  // 4. Background Sync Monitor
  SyncEngine.init((isOnline) => {
    console.log(isOnline ? 'Online mode' : 'Offline mode');
  });

  // 5. Button Navigation Transitions
  document.getElementById('btn-goto-signin').onclick = () => {
    Router.navigate('signin');
  };

  document.getElementById('btn-goto-register').onclick = () => {
    Router.navigate('register');
  };

  document.querySelectorAll('.btn-back-splash').forEach((btn) => {
    btn.onclick = () => {
      Router.navigate('splash');
    };
  });

  // Password visibility toggles
  const setupToggle = (btnId, inputId) => {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (btn && input) {
      btn.onclick = () => {
        input.type = input.type === 'password' ? 'text' : 'password';
      };
    }
  };
  setupToggle('toggle-pwd-login', 'login-password');
  setupToggle('toggle-pwd-reg', 'reg-password');

  // 6. Drawer Navigation
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

  // 7. Overflow Menu
  const overflowPopup = document.getElementById('overflow-popup');
  document.getElementById('btn-open-overflow').onclick = (e) => {
    e.stopPropagation();
    overflowPopup.classList.toggle('hidden');
  };

  window.addEventListener('click', () => overflowPopup.classList.add('hidden'));

  document.getElementById('opt-clear-cart').onclick = () => {
    activeCart = [];
    updateChargeDisplay();
    overflowPopup.classList.add('hidden');
  };

  document.getElementById('opt-trigger-sync').onclick = async () => {
    overflowPopup.classList.add('hidden');
    await SyncEngine.syncPendingData();
  };

  // Form Submissions
  document.getElementById('form-mobile-login').onsubmit = (e) => {
    e.preventDefault();
    Router.navigate('pos');
    renderSampleCatalog();
  };

  document.getElementById('form-mobile-reg').onsubmit = (e) => {
    e.preventDefault();
    Router.navigate('pos');
    renderSampleCatalog();
  };
});

function renderSampleCatalog() {
  const container = document.getElementById('pos-items-container');
  const sampleItems = [
    { id: '1', name: 'Charger', stock: 14, price: 0.00 },
    { id: '2', name: 'USB Cable', stock: 25, price: 5.00 },
    { id: '3', name: 'Power Bank', stock: 8, price: 25.00 },
  ];

  container.innerHTML = sampleItems
    .map(
      (item) => `
    <div class="product-list-row" data-id="${item.id}">
      <div class="product-row-left">
        <div class="product-row-circle">Smart<br/>Sales</div>
        <div>
          <div style="font-weight:600; font-size:0.95rem;">${item.name}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">${item.stock} In Stock</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-weight:600;">${item.price.toFixed(2)}</span>
        <i data-lucide="info" style="width:18px; height:18px; color:#94a3b8;"></i>
      </div>
    </div>
  `
    )
    .join('');

  if (window.lucide) window.lucide.createIcons({ root: container });

  container.querySelectorAll('.product-list-row').forEach((row) => {
    row.onclick = () => {
      const item = sampleItems.find((s) => s.id === row.dataset.id);
      openItemCustomizer(item);
    };
  });
}

function openItemCustomizer(item) {
  currentItemCustomizing = item;
  const modal = document.getElementById('modal-item-customizer');
  document.getElementById('customizer-item-name').textContent = item.name;
  document.getElementById('inp-custom-price').value = item.price.toFixed(2);
  document.getElementById('inp-custom-qty').value = 1;
  modal.classList.remove('hidden');

  document.getElementById('btn-close-customizer').onclick = () => modal.classList.add('hidden');

  document.getElementById('btn-confirm-item-add').onclick = () => {
    const qty = parseFloat(document.getElementById('inp-custom-qty').value) || 1;
    const price = parseFloat(document.getElementById('inp-custom-price').value) || 0;
    activeCart.push({ ...item, qty, price });
    updateChargeDisplay();
    modal.classList.add('hidden');
  };
}

function updateChargeDisplay() {
  const total = activeCart.reduce((sum, i) => sum + i.price * i.qty, 0);
  document.getElementById('lbl-charge-amount').textContent = total.toFixed(2);
}