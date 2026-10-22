import { IDB } from './idb.js';
import { SyncEngine } from './sync.js';
import { CONFIG } from './config.js';

let activeCart = [];
let currentItemCustomizing = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) window.lucide.createIcons();

  // 1. Initialize IndexedDB
  await IDB.init();

  // 2. Register Service Worker for PWA Offline Install
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW failed:', err));
  }

  // 3. Start Sync Monitor
  SyncEngine.init((isOnline) => {
    console.log(isOnline ? 'Online - Background sync active' : 'Offline Mode');
  });

  // 4. View Transitions
  const splashScreen = document.getElementById('screen-splash');
  const signinScreen = document.getElementById('screen-signin');
  const registerScreen = document.getElementById('screen-register');
  const posScreen = document.getElementById('screen-pos');

  document.getElementById('btn-goto-signin').onclick = () => {
    splashScreen.classList.add('hidden');
    signinScreen.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
  };

  document.getElementById('btn-goto-register').onclick = () => {
    splashScreen.classList.add('hidden');
    registerScreen.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
  };

  document.querySelectorAll('.btn-back-splash').forEach((btn) => {
    btn.onclick = () => {
      signinScreen.classList.add('hidden');
      registerScreen.classList.add('hidden');
      splashScreen.classList.remove('hidden');
      if (window.lucide) window.lucide.createIcons();
    };
  });

  // 5. Drawer Controls
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

  // 6. Back Office Link (opens GitHub Pages portal in external tab)
  document.getElementById('link-goto-backoffice').onclick = () => {
    window.open(CONFIG.BACKOFFICE_URL, '_blank');
  };

  // 7. Overflow 3-dot Menu Toggle
  const overflowPopup = document.getElementById('overflow-popup');
  document.getElementById('btn-open-overflow').onclick = (e) => {
    e.stopPropagation();
    overflowPopup.classList.toggle('hidden');
  };

  window.addEventListener('click', () => overflowPopup.classList.add('hidden'));

  // Clear Ticket Action
  document.getElementById('opt-clear-cart').onclick = () => {
    activeCart = [];
    updateChargeDisplay();
    overflowPopup.classList.add('hidden');
  };

  // Manual Sync Action
  document.getElementById('opt-trigger-sync').onclick = async () => {
    overflowPopup.classList.add('hidden');
    await SyncEngine.syncPendingData();
  };

  // Demo: Bypass signin directly to POS screen on form submit
  document.getElementById('form-mobile-login').onsubmit = (e) => {
    e.preventDefault();
    signinScreen.classList.add('hidden');
    posScreen.classList.remove('hidden');
    renderSampleCatalog();
    if (window.lucide) window.lucide.createIcons();
  };
});

function renderSampleCatalog() {
  const container = document.getElementById('pos-items-container');
  const sampleItems = [
    { id: '1', name: 'Charger', stock: 14, price: 0.00 },
    { id: '2', name: 'USB Cable', stock: 25, price: 5.00 },
    { id: '3', name: 'Power Bank', stock: 8, price: 25.00 }
  ];

  container.innerHTML = sampleItems.map((item) => `
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
  `).join('');

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
  const total = activeCart.reduce((sum, i) => sum + (i.price * i.qty), 0);
  document.getElementById('lbl-charge-amount').textContent = total.toFixed(2);
}