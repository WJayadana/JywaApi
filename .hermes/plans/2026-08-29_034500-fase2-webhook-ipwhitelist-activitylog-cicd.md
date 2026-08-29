# JywaApi Fase 2 — Implementation Plan

> **For Hermes:** Kerjakan per-phase dengan TDD strict (RED → GREEN → verify). Commit per task selesai. Restart service + live verify sebelum push.

**Goal:** Menambah 4 kapabilitas: webhook ke reseller, IP whitelist per API key, activity log login untuk user, dan CI/CD pipeline.

**Arsitektur saat ini:** Node.js Express + better-sqlite3, systemd `jywa-api` di belakang Caddy (`https://jywa.tech`). Auth internal via JWT, public API v1 via API key (`users.api_key`). Provider Digiflazz native fetch, price cache JSON dengan round-robin scheduler 10 menit.

**Tech stack:** Node 22 native test runner, express, better-sqlite3, dotenvx, Caddy, GitHub Actions (baru).

- **Keputusan user (2026-08-29):**
- Deposit reseller → DITUNDA lagi
- Webhook reseller → JALAN
- Rate limiting → TIDAK; diganti IP whitelist per reseller
- IP whitelist → self-service saja (user mengatur IP sendiri)
- Activity log → JALAN (user bisa pantau login selain dirinya)
- Webhook event → `transaction.update` dulu; `balance.update` ditunda
- CI/CD → auto-deploy setiap push ke `main` setelah CI hijau (eksekusi setelah di-ACC)  

---

## Phase 1 — Activity Log (login monitoring)

Prioritas pertama karena paling kecil dan langsung berguna untuk semua user.

**Desain:**
- Tabel baru `auth_logs`:
  - `id` TEXT PK
  - `user_id` TEXT FK → users(id) ON DELETE CASCADE
  - `event` TEXT CHECK: `login_success`, `login_failed`, `api_key_generated`, `api_key_revoked`
  - `ip` TEXT — dari `req.ip` (perlu `app.set('trust proxy', 1)` karena di belakang Caddy)
  - `user_agent` TEXT
  - `created_at` TEXT DEFAULT datetime('now')
  - Index: `idx_auth_logs_user`, `idx_auth_logs_created`
- Hook di `src/routes/auth.js` login handler: catat sukses dan gagal (gagal juga dicatat kalau identifier match user yang ada — biar user tahu ada yang coba-coba).
- Hook di `src/routes/users.js`: catat generate/revoke API key.
- Endpoint baru `GET /api/users/me/activity` (JWT): paginated, filter `event`, urut terbaru. Response: event, ip, user_agent, created_at.
- Retensi: hapus log > 90 hari via scheduler yang sudah ada (tambah tick harian).

**Files:**
- Modify: `src/db.js` (tabel + index)
- Create: `src/services/auth-log.js` (helper `logAuthEvent(userId, event, req)`)
- Modify: `src/routes/auth.js`, `src/routes/users.js`, `src/app.js` (trust proxy)
- Create: `test/auth-log.test.js`
- Modify: `openapi.yaml`, `public/docs.html`

**Test plan (RED dulu):**
1. Login sukses → row `login_success` dengan IP tercatat
2. Login gagal (password salah, user ada) → row `login_failed`
3. `GET /api/users/me/activity` → hanya log milik sendiri, paginated
4. User lain tidak bisa lihat log user berbeda
5. Generate API key → `api_key_generated` tercatat

**Verifikasi:** `node --test` full suite + curl live `/api/users/me/activity` via HTTPS.

---

## Phase 2 — IP Whitelist per API key (pengganti rate limiting)

**Desain:**
- Kolom baru `users.api_key_ips` TEXT — JSON array string, contoh `["103.10.20.30", "2400:cb00::/32"]`. NULL/empty = semua IP boleh (default, backward compatible).
- Support exact IPv4/IPv6 dan CIDR (pakai modul kecil `ip-cidr` ATAU implement subnet check manual — cek dulu; kalau dependency footprint kecil, pakai lib).
- Enforcement di `src/middleware/api-key.js`: setelah key valid, cek `req.ip` terhadap whitelist. Tidak match → `403 Forbidden` `{ error: 'Forbidden', message: 'IP not whitelisted' }` + catat `auth_logs` event baru `api_ip_rejected`.
- Endpoint manage (JWT, self-service):
  - `GET /api/users/me/api-key/ips` → list whitelist
  - `PUT /api/users/me/api-key/ips` body `{ ips: ["1.2.3.4"] }` → replace seluruh list (max 20 entri, validasi format IP/CIDR)
  - Kirim `{ ips: [] }` → kosongkan (allow all)
- Owner bisa lihat/set whitelist user lain via `PUT /api/users/:id/api-key/ips` (opsional, konfirmasi dulu).

**Files:**
- Modify: `src/db.js` (ALTER TABLE — perlu migration guard `PRAGMA table_info`)
- Modify: `src/middleware/api-key.js`
- Create: `src/services/ip-whitelist.js` (parse + match, unit-testable)
- Modify: `src/routes/users.js`
- Create: `test/ip-whitelist.test.js`
- Modify: `openapi.yaml`, `public/docs.html`

**Test plan (RED dulu):**
1. `computeMatch('1.2.3.4', ['1.2.3.4'])` true; beda IP false
2. CIDR `10.0.0.0/8` match `10.1.2.3`
3. Whitelist kosong/NULL → semua IP lolos
4. Request v1 dari IP non-whitelist → 403 + auth_log `api_ip_rejected`
5. PUT validasi: bukan array → 400; IP invalid → 400; > 20 → 400

**Catatan penting:** `trust proxy` HARUS aktif dulu (Phase 1) supaya `req.ip` berisi IP asli klien dari header Caddy, bukan 127.0.0.1.

---

## Phase 3 — Webhook ke Reseller

**Desain:**
- Kolom baru `users.webhook_url` TEXT + `users.webhook_secret` TEXT.
- Self-service (JWT):
  - `PUT /api/users/me/webhook` body `{ url }` → set URL (harus https://, max 500 char). Server generate `webhook_secret` (`whsec_` + 32 hex) dan return SEKALI di response.
  - `DELETE /api/users/me/webhook` → hapus.
  - `POST /api/users/me/webhook/test` → kirim event `ping` untuk verifikasi endpoint reseller.
- Event yang dikirim: `transaction.update` — setiap transaksi user berubah status (success/failed setelah pending, atau update dari webhook Digiflazz nanti).
- Payload JSON:
  ```json
  {
    "event": "transaction.update",
    "timestamp": "2026-08-29T03:00:00.000Z",
    "data": { "ref_id": "...", "sku": "...", "status": "success", "sn": "...", "harga": 1133 }
  }
  ```
- Signature: header `X-Jywa-Signature: sha256=<hmac_hex>` — HMAC-SHA256 atas raw body pakai `webhook_secret` (pola sama dengan webhook Digiflazz inbound yang sudah ada, tapi SHA256).
- Delivery: fire-and-forget async dengan retry sederhana — 3 percobaan, backoff 5s/30s/120s, timeout 10s per request. Tabel `webhook_deliveries` untuk audit (id, user_id, event, payload, attempt, status_code, delivered_at). TIDAK pakai queue eksternal — in-process `setTimeout`, cukup untuk skala sekarang.
- Failure tidak pernah mempengaruhi transaksi (débit/refund tetap jalan).

**Files:**
- Modify: `src/db.js` (2 kolom + tabel `webhook_deliveries`)
- Create: `src/services/webhook-dispatcher.js`
- Modify: `src/routes/v1.js` (panggil dispatcher setelah status final)
- Modify: `src/routes/users.js` (manage webhook)
- Create: `test/webhook-reseller.test.js` (mock server penerima, assert signature valid)
- Modify: `openapi.yaml`, `public/docs.html`

**Test plan (RED dulu):**
1. Set webhook URL → secret whsec_ dikembalikan sekali
2. Transaksi sukses → mock receiver menerima payload `transaction.update` dengan signature SHA256 valid
3. Signature dihitung atas raw body — verify manual di test
4. Receiver mati (ECONNREFUSED) → transaksi TETAP sukses, delivery tercatat failed
5. `POST /webhook/test` → event `ping` terkirim
6. URL non-https → 400

---

## Phase 4 — CI/CD (GitHub Actions)

**Desain:**
- **CI** — `.github/workflows/ci.yml`, trigger `push` + `pull_request` ke `main`:
  1. Checkout, setup Node 22, `npm ci`
  2. `node --test` (env test dummy — TIDAK butuh credential Digiflazz asli karena test pakai mock)
  3. `npx @redocly/cli lint openapi.yaml`
- **CD** — `.github/workflows/deploy.yml`, trigger `push` ke `main` SETELAH CI hijau (`workflow_run` atau job dependency):
  1. SSH ke VPS (secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`)
  2. `cd /root/JywaApi && git pull --ff-only && npm ci --omit=dev && systemctl restart jywa-api`
  3. Health check: `curl -f https://jywa.tech/health` — gagal → exit 1 (deploy merah, tapi TIDAK auto-rollback dulu; rollback manual via `git reset` — keep it simple)
- Secrets yang harus diset di repo GitHub: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (generate keypair khusus deploy, taruh public key di `authorized_keys` VPS, private key di GitHub secret).
- `.env` di server TIDAK disentuh CI/CD — tetap manual di VPS.
- Badge CI di README (opsional).

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`
- Modify: `README.md` (badge, deploy notes)

**Verifikasi:**
1. Push dummy commit → CI jalan hijau di tab Actions
2. CD jalan → service restart → health 200
3. Test PR: bikin branch, buka PR → CI jalan tanpa deploy

**Risiko:**
- SSH key bocor = akses VPS → pakai key khusus deploy dengan `command=` restriction di authorized_keys kalau mau lebih ketat
- Deploy saat scheduler sedang sync → aman, systemd restart SIGTERM ditangani (`scheduler.stop()` sudah di-hook)

---

## Urutan Eksekusi & Estimasi

| # | Phase | Kenapa urutan ini | Estimasi effort |
|---|-------|--------------------|-----------------|
| 1 | Activity log | Kecil, fondasi `trust proxy` + `auth_logs` dipakai Phase 2 | ~1 sesi |
| 2 | IP whitelist | Butuh `req.ip` benar + auth_logs dari Phase 1 | ~1 sesi |
| 3 | Webhook reseller | Paling besar, independen | ~1-2 sesi |
| 4 | CI/CD | Terakhir supaya pipeline test suite sudah lengkap | ~1 sesi |

## Open Questions (jawab sebelum mulai)

1. **Phase 2:** Owner perlu bisa set whitelist IP user lain, atau self-service saja?
2. **Phase 3:** Event webhook cukup `transaction.update` dulu, atau sekalian `balance.update` (saldo berubah karena refund/deposit owner)?
3. **Phase 4:** Auto-deploy setiap push ke main, atau manual trigger (`workflow_dispatch`) dulu biar lu yang pencet?

## Ditunda (belum masuk plan)

- Deposit reseller (transfer saldo owner → reseller)
- Rate limiting (diganti IP whitelist)
- Auto-rollback deployment
- Postpaid (pasca) flow — nunggu produk pasca ditambahkan di akun Digiflazz
