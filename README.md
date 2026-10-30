<div align="center">

# 🛍️ QuickSell POS Mobile

[![PWA Ready](https://img.shields.io/badge/PWA-Ready-0d9488?style=for-the-badge&logo=pwa&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)
[![Supabase Direct Integration](https://img.shields.io/badge/Database-Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com)
[![IndexedDB Cache](https://img.shields.io/badge/Offline_Storage-IndexedDB-4285F4?style=for-the-badge&logo=google-chrome&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge)](LICENSE)

**An offline-first, high-performance Progressive Web Application (PWA) Point-of-Sale terminal built for retail stores, supermarkets, restaurants, and service providers across East Africa.**

[Features](#-features) • [Tech Stack](#-tech-stack) • [Database Setup](#-database--storage-setup) • [Installation & Local Setup](#-installation--local-setup) • [Project Architecture](#-project-architecture)

</div>

---

## 🌟 Overview

**QuickSell POS Mobile** is designed to provide seamless retail point-of-sale operations on mobile devices and handheld Android terminals. It operates uninterrupted during network outages through robust local storage (`IndexedDB`) and automatically syncs pending sales, new inventory, customers, and catalog changes when internet connectivity is restored.

---

## ✨ Features

### 🛒 Point of Sale Terminal
* **Fast Catalog Browsing:** Visual product grids with category filtering, image previews, and instantaneous search by name, SKU, or barcode.
* **Item Customizer:** Real-time quantity adjustment, custom line item prices, percentage/value discounts, and special item notes.
* **Ticket Discounts & Checkout:** Global order discounts, currency indicators, and payment tendering (Cash, M-PESA, Card).
* **Customer Selection & Attachment:** Quick customer lookup or instant registration during active checkout.

### 📶 Offline-First Engine
* **Instant UI Responsiveness:** Decrements local stock in IndexedDB immediately upon checkout without waiting for network responses.
* **Background Delta Syncing:** Background sync mechanism for delta updates and local outbox queue processing (`CREATE`, `UPDATE`, `DELETE`).
* **Realtime Broadcasts:** Live updates when catalog items or inventory levels are updated from the Back-Office portal.

### 📦 Products, Categories & Inventory
* **Product Management:** Full support for adding, editing, and deleting items with optional high-resolution product image uploads via Supabase Storage.
* **Batch Operations:** Multi-select checkboxing for bulk product deletions.
* **Category Management:** Create, edit, or delete catalog categories.
* **Stock Control:** Goods Received Note (GRN) logging, Stock Adjustment (SA) for shrinkage/damage, and Transfer of Goods (TOG) to other branches.

### 🌍 Regional & Security Localization
* **East African Regional Localization:** Dynamic country selection supporting Kenya (🇰🇪 +254, KES), Tanzania (🇹🇿 +255, TZS), Uganda (🇺🇬 +256, UGX), Rwanda (🇷🇼 +250, RWF), Burundi (🇧🇮 +257, BIF), and South Sudan (🇸🇸 +211, SSP).
* **Terminal PIN Lock Screen:** 4-digit terminal security keypad to restrict unauthorized access when left idle or installed on shared handhelds.
* **Keep Awake Mode:** Screen WakeLock API integration preventing screen timeout during active operation.

---

## 🛠️ Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend Framework** | HTML5, CSS3, ES6 Modules | Pure Native JavaScript (No heavy frameworks or bundle overhead) |
| **Icons & UI** | Lucide Icons, Custom CSS | Touch-first, responsive mobile layouts |
| **Offline Storage** | IndexedDB (`IDB.js`) | Client-side transactional storage for catalog, receipts, & outbox |
| **Service Worker** | Cache-First PWA Worker | Static asset caching and offline SPA navigation fallback |
| **Database & Auth** | Supabase (PostgreSQL) | Auth, Realtime Postgres Changes, RPC functions & Storage Buckets |
| **Media Storage** | Supabase Storage | `product-images` bucket with RLS security policies |

---

## 📁 Project Structure

```text
qs-pos-mobile-main/
├── assets/
│   ├── icon-192.png               # PWA App Icon (192x192)
│   └── icon-512.png               # PWA App Icon (512x512)
├── css/
│   ├── mobile-layout.css          # Structural layout, modals, drawers, keypads
│   └── mobile-theme.css           # Color variables, typography, inputs, buttons
├── js/
│   ├── app.js                     # Core application initializer, DOM bindings, modals
│   ├── auth.js                    # Supabase Auth, session sync, regional defaults
│   ├── cart.js                    # Cart state, discount logic, totals calculation
│   ├── config.js                  # Environment keys, Supabase URLs, constants
│   ├── idb.js                     # IndexedDB wrapper & offline transaction helpers
│   ├── router.js                  # Single Page Application (SPA) view navigator
│   └── sync.js                    # Outbox processor, background sync engine, realtime
├── index.html                     # Primary application HTML structure
├── manifest.json                  # Progressive Web App manifest
├── README.md                      # Project documentation
└── sw.js                          # Service Worker for offline asset caching
```

---

## 🗄️ Database & Storage Setup

Before running the client app, ensure your **Supabase Project** has the `image_url` column and `product-images` storage bucket configured. Run this SQL in your **Supabase Dashboard → SQL Editor**:

```sql
-- 1. Add image_url column to products table
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT NULL;

-- 2. Create Storage Bucket for Product Images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images', 
  'product-images', 
  TRUE, 
  5242880, -- 5 MB Max Limit
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3. Row-Level Security (RLS) Policies
DROP POLICY IF EXISTS "Public Read Access for Product Images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Users Upload Access" ON storage.objects;

CREATE POLICY "Public Read Access for Product Images"
ON storage.objects FOR SELECT USING (bucket_id = 'product-images');

CREATE POLICY "Authenticated Users Upload Access"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'product-images');

CREATE POLICY "Authenticated Users Update Access"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'product-images');

CREATE POLICY "Authenticated Users Delete Access"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'product-images');
```

---

## 🚀 Installation & Local Setup

> **Important Note regarding `file://` execution:**
> Modern web browsers block JavaScript ES Modules (`import ... from ...`) when opened directly via local files (`file:///`). To run locally, serve the directory using a web server.

### Option A: Local Web Server (Node.js)

1. Clone or download the repository:
   ```bash
   git clone https://github.com/your-username/qs-pos-mobile.git
   cd qs-pos-mobile
   ```

2. Start a local HTTP server:
   ```bash
   npx serve .
   # OR
   npx http-server -p 8080
   ```

3. Open your browser and navigate to `http://localhost:8080`.

---

### Option B: Python Local Server

```bash
python3 -m http.server 8080
```
Open `http://localhost:8080` in your web browser.

---

### Option C: Testing on Android via Termux

1. Place the project folder in your device storage.
2. Open **Termux** and run:
   ```bash
   pkg install python
   cd /sdcard/qs-pos-mobile-main/
   python3 -m http.server 8080
   ```
3. Open Chrome on your Android device and visit `http://localhost:8080`.

---

### Option D: Building as a Native Android App (Capacitor)

To wrap this project into a native Android `.apk` / `.aab`:

```bash
npm init @capacitor/app
npm install @capacitor/core @capacitor/android
npx cap add android
npx cap copy
npx cap open android
```

Capacitor serves assets over an internal `http://localhost` bridge inside Android WebView, completely bypassing CORS `file://` restrictions.

---

## ⚡ Offline & Sync Architecture

```
+-----------------------------------------------------------------------+
|                            MOBILE POS TERMINAL                        |
|                                                                       |
|  [ User Action ] ---> [ Cart / Terminal UI ]                          |
|                             |                                         |
|                             v                                         |
|                     [ Local IndexedDB ] <--- Immediate UI Update     |
|                             |                                         |
|                             v                                         |
|                     [ Outbox Queue ]                                  |
+-----------------------------|-----------------------------------------+
                              |
                     Is Network Available?
                        /           \
                      YES            NO
                      /               \
                     v                 v
          [ Process Outbox ]      [ Retain in IDB ]
                 |                (Sync when Online)
                 v
         [ Supabase DB ]
```

---

## 🤝 Contributing

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/NewFeature`)
3. Commit your Changes (`git commit -m 'Add new feature'`)
4. Push to the Branch (`git push origin feature/NewFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.