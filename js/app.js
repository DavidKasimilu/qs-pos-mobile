// js/app.js
import { auth } from './auth.js';
import { syncEngine } from './sync.js';
import { idb } from './idb.js';

class App {
  async init() {
    // 1. Initialize IndexedDB
    await idb.open();

    // 2. Network status monitoring
    this.setupNetworkListeners();

    // 3. Check Session
    if (auth.isAuthenticated()) {
      syncEngine.start();
    }

    // 4. Hook Custom POS Events
    this.setupAppEventListeners();
  }

  setupNetworkListeners() {
    const updateIndicator = () => {
      const isOnline = navigator.onLine;
      const indicator = document.getElementById('network-status');
      if (indicator) {
        indicator.textContent = isOnline ? 'Online' : 'Offline';
        indicator.className = isOnline ? 'status-online' : 'status-offline';
      }
    };

    window.addEventListener('online', async () => {
      updateIndicator();
      await syncEngine.pullDeltas();
      await syncEngine.flushOutbox();
    });

    window.addEventListener('offline', () => {
      updateIndicator();
    });

    updateIndicator();
  }

  setupAppEventListeners() {
    // Trigger product grid re-render when new products or inventories arrive
    window.addEventListener('catalog-updated', () => {
      if (window.renderProductGrid) window.renderProductGrid();
    });

    window.addEventListener('inventory-updated', () => {
      if (window.renderProductGrid) window.renderProductGrid();
    });

    // Provide a helper to register customers directly from the counter
    window.createPosCustomer = async (customerData) => {
      const currentUser = auth.getCurrentUser();
      const newCustomer = {
        id: crypto.randomUUID(),
        shop_id: currentUser.shop_id,
        name: customerData.name,
        phone: customerData.phone || null,
        email: customerData.email || null,
        loyalty_points: 0,
        outstanding_balance: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Store in local IndexedDB
      await idb.put('customers', newCustomer);

      // Queue into outbox for push
      await idb.put('outbox', {
        id: crypto.randomUUID(),
        type: 'CREATE_CUSTOMER',
        payload: newCustomer,
        created_at: new Date().toISOString()
      });

      // Attempt flush if online
      if (navigator.onLine) {
        syncEngine.flushOutbox();
      }

      return newCustomer;
    };
  }
}

export const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());