// js/idb.js
const DB_NAME = 'QuickSellMobilePOS';
const DB_VERSION = 2;

class IDBManager {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Core catalog stores
        if (!db.objectStoreNames.contains('products')) {
          const store = db.createObjectStore('products', { keyPath: 'id' });
          store.createIndex('shop_id', 'shop_id', { unique: false });
          store.createIndex('category_id', 'category_id', { unique: false });
          store.createIndex('barcode', 'barcode', { unique: false });
          store.createIndex('sku', 'sku', { unique: false });
        }

        if (!db.objectStoreNames.contains('categories')) {
          const store = db.createObjectStore('categories', { keyPath: 'id' });
          store.createIndex('shop_id', 'shop_id', { unique: false });
        }

        if (!db.objectStoreNames.contains('inventory')) {
          const store = db.createObjectStore('inventory', { keyPath: 'id' });
          store.createIndex('product_id', 'product_id', { unique: false });
          store.createIndex('shop_id', 'shop_id', { unique: false });
        }

        if (!db.objectStoreNames.contains('customers')) {
          const store = db.createObjectStore('customers', { keyPath: 'id' });
          store.createIndex('shop_id', 'shop_id', { unique: false });
          store.createIndex('phone', 'phone', { unique: false });
        }

        // Transactions & receipts
        if (!db.objectStoreNames.contains('orders')) {
          const store = db.createObjectStore('orders', { keyPath: 'id' });
          store.createIndex('receipt_no', 'receipt_no', { unique: true });
          store.createIndex('shop_id', 'shop_id', { unique: false });
        }

        if (!db.objectStoreNames.contains('order_items')) {
          const store = db.createObjectStore('order_items', { keyPath: 'id' });
          store.createIndex('order_id', 'order_id', { unique: false });
        }

        if (!db.objectStoreNames.contains('payments')) {
          const store = db.createObjectStore('payments', { keyPath: 'id' });
          store.createIndex('order_id', 'order_id', { unique: false });
        }

        if (!db.objectStoreNames.contains('shifts')) {
          const store = db.createObjectStore('shifts', { keyPath: 'id' });
          store.createIndex('shop_id', 'shop_id', { unique: false });
        }

        // Outbox queue for all mutations awaiting cloud sync
        if (!db.objectStoreNames.contains('outbox')) {
          const store = db.createObjectStore('outbox', { keyPath: 'id' });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('created_at', 'created_at', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  async tx(storeNames, mode = 'readonly') {
    const db = await this.open();
    return db.transaction(storeNames, mode);
  }

  async getAll(storeName) {
    const tx = await this.tx(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async get(storeName, key) {
    const tx = await this.tx(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(storeName, value) {
    const tx = await this.tx(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const req = store.put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async putBatch(storeName, items) {
    if (!items || !items.length) return;
    const tx = await this.tx(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      items.forEach((item) => store.put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(storeName, key) {
    const tx = await this.tx(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // Atomically subtract inventory for immediate offline UI feedback
  async decrementInventoryStock(productId, deltaQty) {
    const tx = await this.tx('inventory', 'readwrite');
    const store = tx.objectStore('inventory');
    const index = store.index('product_id');

    return new Promise((resolve, reject) => {
      const req = index.get(productId);
      req.onsuccess = () => {
        const item = req.result;
        if (item) {
          item.quantity_on_hand = (parseFloat(item.quantity_on_hand) || 0) - parseFloat(deltaQty);
          item.updated_at = new Date().toISOString();
          store.put(item);
        }
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }
}

export const idb = new IDBManager();