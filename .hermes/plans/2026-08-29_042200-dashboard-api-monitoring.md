# Dashboard JywaApi — Implementation Plan

> **Goal:** React SPA (Vite) served dari Express `/public/dashboard` untuk monitoring API dan data. Pakai JWT auth yang sama. Fokus: overview, stats, saldo, produk, transaksi.

**Tech Stack:**
- React 18 + Vite (build output ke `public/dashboard/`)
- React Router v6 (client-side routing)
- Plain CSS (matching tema gelap JywaApi, tanpa framework UI)
- Served via `app.use(express.static('public'))` — tidak perlu CORS
- Auth: JWT yang sama dari `POST /api/auth/login`, token di `localStorage` key `jywa_token`

**API Base:** `window.location.origin` (same-origin, no CORS needed)

---

## Arsitektur

```
JywaApi/
  dashboard/              ← Vite project (npm create vite)
    src/
      App.jsx            ← Router + auth guard
      pages/
        Login.jsx        ← JWT login form
        Dashboard.jsx    ← Overview (health + quick stats)
        Stats.jsx        ← Owner: sales/cost/profit + top products
        Digiflazz.jsx    ← Owner: saldo + deposit
        Products.jsx     ← Owner: browse/search cached products
        Transactions.jsx ← All: own transaction history
      components/
        Navbar.jsx
        ApiCard.jsx      ← reusable card untuk stat cards
        LoadingSpinner.jsx
        ErrorBanner.jsx
      lib/
        api.js           ← fetch wrapper dengan auto-JWT header
      main.jsx
    public/
    vite.config.js       ← outputDir: '../public/dashboard', base: '/dashboard/'
    index.html
  public/
    dashboard/            ← build output (gitignored)
```

**Route protection:**
- `/` → redirect ke `/dashboard` atau `/login`
- `/dashboard/login` → public
- `/dashboard/*` → require JWT; role check per page

**Role-aware pages:**
- Owner-only: `/dashboard/stats`, `/dashboard/digiflazz`, `/dashboard/products`
- All authenticated: `/dashboard/transactions`

---

## Tahap Implementation

### Task 1: Setup Vite project

**Files:**
- Create: `dashboard/` (Vite React project)
- Modify: `.gitignore` (tambah `/public/dashboard`)
- Modify: `src/app.js` (sudah `express.static('public')` — `public/dashboard/` otomatis served)

**Steps:**
1. `cd /root/JywaApi && npm create vite@latest dashboard -- --template react`
2. Di `dashboard/vite.config.js`, set:
   ```js
   import { defineConfig } from 'vite'
   export default defineConfig({
     base: '/dashboard/',
     build: { outDir: '../public/dashboard' }
   })
   ```
3. `dashboard/package.json` — add `"proxy": "http://localhost:3000"` (dev only, ignored di prod)
4. `.gitignore` — tambah `public/dashboard/`
5. Hapus `dashboard/src/assets/` + `dashboard/src/App.css` (pakai global CSS)
6. Build dev: `cd dashboard && npm install && npm run build && cd ..`
7. Verify: `curl -s http://localhost:3000/dashboard/` → HTML (bukan 404)

---

### Task 2: Global CSS + theme

**Files:**
- Create: `dashboard/src/index.css` (global styles, dark theme matching JywaApi docs)

**Steps:**
1. Warna: background `#0d1117`, surface `#161b22`, border `#30363d`, accent `#58a6ff`, text `#c9d1d9`
2. Font: `Inter` atau sistem sans-serif
3. Buat `.api-card` class: rounded corners, subtle border, padding 16px
4. Navbar styling: horizontal top bar, logo kiri, logout kanan
5. Form styling: dark inputs, focus ring blue
6. Table styling: zebra rows, sticky header

---

### Task 3: API lib + auth context

**Files:**
- Create: `dashboard/src/lib/api.js`
- Create: `dashboard/src/context/AuthContext.jsx`

**Steps:**

**`api.js`** — fetch wrapper:
```js
export function apiFetch(path, options = {}) {
  const token = localStorage.getItem('jywa_token');
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  }).then(async (res) => {
    const data = await res.json().catch(() => null);
    if (!res.ok) throw { status: res.status, data };
    return data;
  });
}
```

**`AuthContext.jsx`**:
- `user` (from `/api/users/me`) + `token` state
- `login(username, password)` → POST `/api/auth/login`, save token + fetch user
- `logout()` → clear localStorage, redirect to /login
- `loading` + `isOwner` computed
- `useAuth()` hook

---

### Task 4: App router + login page

**Files:**
- Modify: `dashboard/src/App.jsx`
- Create: `dashboard/src/pages/Login.jsx`
- Create: `dashboard/src/components/Navbar.jsx`

**Steps:**

**`App.jsx`**: React Router setup:
```jsx
<Routes>
  <Route path="/login" element={<Login />} />
  <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
    <Route index element={<Dashboard />} />
    <Route path="stats" element={<OwnerRoute><Stats /></OwnerRoute>} />
    <Route path="digiflazz" element={<OwnerRoute><Digiflazz /></OwnerRoute>} />
    <Route path="products" element={<OwnerRoute><Products /></OwnerRoute>} />
    <Route path="transactions" element={<Transactions />} />
  </Route>
</Routes>
```

**`Login.jsx`**: Form username/password → call `login()` → redirect. Tampilkan error jika invalid. Styling dark, centered card.

**`Navbar.jsx`**: Logo "Jywa Dashboard" kiri, nav links tengah (Dashboard, Stats, Digiflazz, Products, Transactions), username + logout kanan. Owner sees extra nav items.

---

### Task 5: Dashboard overview page

**Files:**
- Create: `dashboard/src/pages/Dashboard.jsx`

**Steps:**
1. Fetch `/health` (no auth needed)
2. Fetch `/api/v1/stats` (owner: total_sales, total_profit, successful_transactions, failed_transactions)
3. Tampilkan 4 stat cards: Total Sales, Total Profit, Successful TX, Failed TX
4. Tampilkan uptime / service status
5. Tampilkan timestamp last cache sync (dari `data/products.json` `last_updated` via API endpoint — atau bisa buat endpoint kecil `/api/health/extended`)

**Note:** `/api/v1/stats` butuh API key owner. Untuk SPA yang pakai JWT, bisa pakai `/api/stats` (legacy, JWT + owner). Tapi dashboard akan fetch `/api/v1/stats` karena API key owner perlu di-hardcode? Atau buat endpoint `/api/owner/dashboard` yang pakai JWT owner?

**Decision:** Untuk SPA, pakai JWT + `/api/v1/stats`. Tapi `/api/v1/stats` pakai API key auth. Buat endpoint baru `/api/owner/stats` yang pakai JWT + owner role check. Ini lebih konsisten dengan SPA auth model.

**Tambah:**
- Modify `src/routes/stats.js` — export `/api/owner/stats` route yang pakai JWT auth (bukan API key)
- Atau tambah di `src/routes/users.js` endpoint `/me/stats` yang pakai JWT

**Revised approach:** Bikin `/api/users/me/stats` (JWT auth) untuk dashboard. Stats untuk own transactions? Tapi owner mau lihat GLOBAL stats, bukan own. Buat `/api/owner/dashboard` route baru di `src/routes/stats.js` — pakai JWT auth + owner role check. Endpoint ini gabungkan health + stats + digiflazz saldo dalam satu request (减少 request untuk dashboard).

---

### Task 6: Stats page (Owner)

**Files:**
- Create: `dashboard/src/pages/Stats.jsx`

**Steps:**
1. Fetch `/api/owner/dashboard` (atau `/api/v1/stats`) dengan date filter `from`/`to`
2. Tampilkan bar chart sederhana (CSS-only, tanpa library): revenue vs cost per periode
3. Tabel top_products
4. Date range picker (两个 input[type=date])
5. Tampilkan breakdown: successful/failed/pending transactions

**Chart approach:** Pure CSS bar chart — `<div class="bar" style="width: X%">`. Simpel dan tanpa dependency.

---

### Task 7: Digiflazz page (Owner)

**Files:**
- Create: `dashboard/src/pages/Digiflazz.jsx`

**Steps:**
1. Fetch `/api/digiflazz/saldo`
2. Tampilkan saldo dalam format mata uang Rp
3. Tombol "Refresh Saldo" (reload dari Digiflazz)
4. Tabel riwayat deposit terakhir (dari `/api/digiflazz/deposit` — tapi ini butuh input)
5. Form deposit kecil di bawah: nominal + submit → POST `/api/digiflazz/deposit`

---

### Task 8: Products page (Owner)

**Files:**
- Create: `dashboard/src/pages/Products.jsx`

**Steps:**
1. Fetch `/api/v1/products` (tanpa search → semua produk)
2. Search input → filter client-side atau query `?search=`
3. Tampilkan dalam tabel: SKU, Nama, Category, Brand, Harga
4. Pagination (dari API)
5. Filter by category

**Note:** `/api/v1/products` butuh API key owner. Untuk JWT dashboard, perlu endpoint baru atau pakai API key yang di-hardcode. Sebaiknya: buat `/api/owner/products` yang pakai JWT owner auth. Tapi karena ini hanya untuk dashboard, boleh aja pakai API key owner di env variable dan expose sebagai endpoint JSON di `src/config.js`.

**Alternative:** Ambil dari `data/products.json` langsung via endpoint statik `/api/products.json` yang serve file JSON (butuh auth middleware). Atau bikin `/api/owner/products` dengan JWT.

**Decision:** Buat `/api/owner/products` dengan JWT owner auth + pagination. Bisa reuse logic dari `src/routes/v1.js` `GET /products` tanpa perlu API key.

---

### Task 9: Transactions page (All users)

**Files:**
- Create: `dashboard/src/pages/Transactions.jsx`

**Steps:**
1. Fetch `/api/v1/transactions` (JWT user → dapat own transactions)
2. Tabel: Ref ID, SKU, Customer, Harga, Status, SN, Tanggal
3. Status badge dengan warna: success=green, failed=red, pending=yellow
4. Search by ref_id
5. Pagination

---

### Task 10: Build + serve + verify

**Files:**
- Modify: `src/app.js` — mount `/dashboard` static (sudah otomatis dari `express.static('public')`)
- Modify: `.gitignore` — `public/dashboard/`

**Steps:**
1. `cd dashboard && npm run build`
2. `curl http://localhost:3000/dashboard/` → HTML with React root
3. Login dengan credentials owner → redirect ke dashboard
4. Cek semua nav links works
5. `systemctl restart jywa-api` + verify live
6. Commit all

---

## Files to Create/Modify

### New files (dashboard Vite project)
- `dashboard/package.json`
- `dashboard/vite.config.js`
- `dashboard/index.html`
- `dashboard/src/main.jsx`
- `dashboard/src/App.jsx`
- `dashboard/src/index.css`
- `dashboard/src/context/AuthContext.jsx`
- `dashboard/src/lib/api.js`
- `dashboard/src/components/Navbar.jsx`
- `dashboard/src/pages/Login.jsx`
- `dashboard/src/pages/Dashboard.jsx`
- `dashboard/src/pages/Stats.jsx`
- `dashboard/src/pages/Digiflazz.jsx`
- `dashboard/src/pages/Products.jsx`
- `dashboard/src/pages/Transactions.jsx`

### Modified JywaApi files
- `src/routes/stats.js` — tambah `GET /api/owner/stats` (JWT + owner role)
- `src/routes/v1.js` — tambah `GET /api/owner/products` (JWT + owner role, paginated)
- `src/app.js` — sudah serve `public/` ✓
- `.gitignore` — tambah `public/dashboard/`
- `public/docs.html` — tambah link ke dashboard

### Verify commands
```bash
cd /root/JywaApi/dashboard && npm run build
curl -s http://localhost:3000/dashboard/ | grep -c 'root'   # harus > 0
# Login flow test
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"jayadana","password":"..."}' | jq .token
```

---

## Risks & Open Questions

1. **API key vs JWT untuk stats/products**: `/api/v1/stats` dan `/api/v1/products` pakai API key auth. Dashboard SPA pakai JWT. Solution: buat endpoint `/api/owner/*` yang pakai JWT owner auth. Owner JWT diperoleh saat login dashboard.

2. **API key owner di env**: `src/config.js` punya `ownerApiKey`? Kalau belum, bisa generate owner API key dari DB dan store di `.env` sebagai `OWNER_API_KEY`. Endpoint baru tetap pakai JWT (lebih konsisten).

3. **Cache products.json**: Kalau `/api/owner/products`直接从 file cache serve, bisa load semua 5114 produk. Perlu pagination di level API (limit/offset), bukan load semua sekaligus.

4. **Build size**: React + Vite tanpa lazy loading bisa besar. Pakai React.lazy + Suspense untuk routing agar dashboard load cepat.

5. **Security SPA + JWT**: Token di localStorage rentan XSS. Tapi ini acceptable untuk internal dashboard. Alternatif: httpOnly cookie (butuh backend change).

---

## Decision Needed Before Implementation

1. Stats/products endpoint — pakai API key owner (hardcode di env) atau buat JWT-based `/api/owner/*` routes?
   → **Rec: JWT-based** — konsisten dengan SPA auth model
2. Pagination size untuk products — 50 items/page?
3. Date range default untuk stats — last 7 days atau last 30 days?
