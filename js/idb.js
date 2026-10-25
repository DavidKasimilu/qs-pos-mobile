export const IDB = {
  dbName: 'qs_mobile_pos_db',
  dbVersion: 4,
  db: null,

  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Core catalog stores
        const stores = [
          'cached_catalog',
          'cached_categories',
          'cached_inventory',
          'cached_customers',
          'offline_orders',
          'cached_receipts',
          'cash_shifts',
          'inventory_logs',
          'outbox'
        ];

        stores.forEach((storeName) => {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, { keyPath: 'id' });
            
            if (storeName === 'cached_catalog') {
              store.createIndex('shop_id', 'shop_id', { unique: false });
              store.createIndex('category_id', 'category_id', { unique: false });
              store.createIndex('barcode', 'barcode', { unique: false });
              store.createIndex('sku', 'sku', { unique: false });
            }

            if (storeName === 'cached_inventory') {
              store.createIndex('product_id', 'product_id', { unique: false });
              store.createIndex('shop_id', 'shop_id', { unique: false });
            }

            if (storeName === 'cached_customers') {
              store.createIndex('shop_id', 'shop_id', { unique: false });
              store.createIndex('phone', 'phone', { unique: false });
            }

            if (storeName === 'offline_orders' || storeName === 'cached_receipts') {
              store.createIndex('receipt_no', 'receipt_no', { unique: false });
              store.createIndex('shop_id', 'shop_id', { unique: false });
            }

            if (storeName === 'outbox') {
              store.createIndex('type', 'type', { unique: false });
              store.createIndex('created_at', 'created_at', { unique: false });
            }
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

  async ensureDb() {
    if (!this.db) {
      await this.init();
    }
    return this.db;
  },

  async getAll(storeName) {
    await this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getItem(storeName, key) {
    await this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async putItem(storeName, item) {
    await this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(item);
      tx.oncomplete = () => resolve(item);
      tx.onerror = () => reject(tx.error);
    });
  },

  async putBatch(storeName, items) {
    await this.ensureDb();
    if (!items || !items.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      items.forEach((item) => store.put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteItem(storeName, key) {
    await this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async setAll(storeName, items) {
    await this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      if (items && items.length) {
        items.forEach((item) => store.put(item));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  // Atomically decrement local inventory for instant offline UI feedback
  async decrementLocalStock(productId, qty) {
    await this.ensureDb();
    const parsedQty = parseFloat(qty) || 0;
    if (parsedQty <= 0) return;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['cached_inventory', 'cached_catalog'], 'readwrite');
      const invStore = tx.objectStore('cached_inventory');
      const catStore = tx.objectStore('cached_catalog');

      // Update cached_inventory
      const invIndex = invStore.index('product_id');
      const invReq = invIndex.get(productId);

      invReq.onsuccess = () => {
        const invRecord = invReq.result;
        if (invRecord) {
          invRecord.quantity_on_hand = (parseFloat(invRecord.quantity_on_hand) || 0) - parsedQty;
          invRecord.updated_at = new Date().toISOString();
          invStore.put(invRecord);
        }
      };

      // Also update cached_catalog if stock_quantity is mapped directly on the product
      const catReq = catStore.get(productId);
      catReq.onsuccess = () => {
        const prod = catReq.result;
        if (prod && prod.stock_quantity !== undefined) {
          prod.stock_quantity = (parseFloat(prod.stock_quantity) || 0) - parsedQty;
          catStore.put(prod);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  // Catalog Helpers
  async getCatalog() { return this.getAll('cached_catalog'); },
  async setCatalog(items) { return this.setAll('cached_catalog', items); },
  async upsertProduct(item) { return this.putItem('cached_catalog', item); },
  async removeProduct(id) { return this.deleteItem('cached_catalog', id); },

  // Inventory Helpers
  async getInventory() { return this.getAll('cached_inventory'); },
  async setInventory(items) { return this.setAll('cached_inventory', items); },
  async upsertInventory(item) { return this.putItem('cached_inventory', item); },

  // Category Helpers
  async getCategories() { return this.getAll('cached_categories'); },
  async setCategories(cats) { return this.setAll('cached_categories', cats); },
  async upsertCategory(cat) { return this.putItem('cached_categories', cat); },
  async removeCategory(id) { return this.deleteItem('cached_categories', id); },

  // Customer Helpers
  async getCustomers() { return this.getAll('cached_customers'); },
  async setCustomers(custs) { return this.setAll('cached_customers', custs); },
  async upsertCustomer(cust) { return this.putItem('cached_customers', cust); },
  async removeCustomer(id) { return this.deleteItem('cached_customers', id); },

  // Order & Receipt Helpers
  async saveOfflineOrder(order) { return this.putItem('offline_orders', order); },
  async getPendingOrders() { return this.getAll('offline_orders'); },
  async removeOfflineOrder(orderId) { return this.deleteItem('offline_orders', orderId); },
  async getReceipts() { return this.getAll('cached_receipts'); },
  async saveReceipt(receipt) { return this.putItem('cached_receipts', receipt); },

  // Outbox Queue Helpers
  async getOutbox() { return this.getAll('outbox'); },
  async queueOutbox(actionType, payload) {
    const queueItem = {
      id: crypto.randomUUID(),
      type: actionType,
      payload: payload,
      created_at: new Date().toISOString()
    };
    return this.putItem('outbox', queueItem);
  },
  async removeOutboxItem(id) { return this.deleteItem('outbox', id); }
};