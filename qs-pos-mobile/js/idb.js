export const IDB = {
  dbName: 'qs_mobile_pos_db',
  dbVersion: 1,
  db: null,

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cached_catalog')) {
          db.createObjectStore('cached_catalog', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('offline_orders')) {
          db.createObjectStore('offline_orders', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('cached_customers')) {
          db.createObjectStore('cached_customers', { keyPath: 'id' });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => reject(e.target.error);
    });
  },

  async setCatalog(items) {
    const tx = this.db.transaction('cached_catalog', 'readwrite');
    const store = tx.objectStore('cached_catalog');
    await store.clear();
    items.forEach((item) => store.put(item));
    return tx.complete;
  },

  async getCatalog() {
    return new Promise((resolve) => {
      const tx = this.db.transaction('cached_catalog', 'readonly');
      const store = tx.objectStore('cached_catalog');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  },

  async saveOfflineOrder(order) {
    const tx = this.db.transaction('offline_orders', 'readwrite');
    const store = tx.objectStore('offline_orders');
    store.put(order);
    return tx.complete;
  },

  async getPendingOrders() {
    return new Promise((resolve) => {
      const tx = this.db.transaction('offline_orders', 'readonly');
      const store = tx.objectStore('offline_orders');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  },

  async removeOfflineOrder(orderId) {
    const tx = this.db.transaction('offline_orders', 'readwrite');
    const store = tx.objectStore('offline_orders');
    store.delete(orderId);
    return tx.complete;
  }
};