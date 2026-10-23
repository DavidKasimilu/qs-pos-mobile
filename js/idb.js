export const IDB = {
  dbName: 'qs_mobile_pos_db',
  dbVersion: 3,
  db: null,

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        ['cached_catalog', 'cached_categories', 'cached_customers', 'offline_orders', 'cached_receipts', 'cash_shifts', 'inventory_logs'].forEach((storeName) => {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'id' });
          }
        });
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => reject(e.target.error);
    });
  },

  async getAll(storeName) {
    return new Promise((resolve) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  },

  async putItem(storeName, item) {
    const tx = this.db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(item);
    return tx.complete;
  },

  async setAll(storeName, items) {
    const tx = this.db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    await store.clear();
    items.forEach((item) => store.put(item));
    return tx.complete;
  },

  // Helpers
  async getCatalog() { return this.getAll('cached_catalog'); },
  async setCatalog(items) { return this.setAll('cached_catalog', items); },
  async getCategories() { return this.getAll('cached_categories'); },
  async setCategories(cats) { return this.setAll('cached_categories', cats); },
  async getCustomers() { return this.getAll('cached_customers'); },
  async setCustomers(custs) { return this.setAll('cached_customers', custs); },
  async saveOfflineOrder(order) { return this.putItem('offline_orders', order); },
  async getPendingOrders() { return this.getAll('offline_orders'); },
  async removeOfflineOrder(orderId) {
    const tx = this.db.transaction('offline_orders', 'readwrite');
    tx.objectStore('offline_orders').delete(orderId);
    return tx.complete;
  }
};
