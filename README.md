# Jywa API

Node.js + Express API server untuk fondasi platform PPOB Jywa.

## Quick start

```bash
npm install
cp .env.example .env
# Isi JWT_SECRET dengan secret acak yang kuat
npm start
```

API lokal listen di `127.0.0.1:3000`; HTTPS publik disediakan Caddy di `https://jywa.tech`.

## Dokumentasi

Buka dokumentasi manual bertema Jywa di:

- **https://jywa.tech/docs** — docs interaktif, endpoint bisa dibuka/tutup, contoh cURL, schema, copy button, dan light/dark mode.
- **https://jywa.tech/openapi.yaml** — raw OpenAPI 3.1 spec untuk Swagger Editor/Redoc/Postman.

Dokumentasi ini sengaja dibuat manual agar visual dan penjelasannya bisa disesuaikan dengan kebutuhan produk PPOB, bukan Swagger UI default.

## Auth

Semua user baru otomatis mendapat role `bronze`. Role yang tersedia:
`owner`, `bronze`, `silver`, `gold`, `reseller`.

```bash
curl -X POST https://jywa.tech/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"user1","email":"user1@example.com","phone":"08123456789","password":"password-123"}'

curl -X POST https://jywa.tech/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"user1","password":"password-123"}'
```

Gunakan token hasil login sebagai `Authorization: Bearer <token>`.

## Endpoint users

### User biasa

- `GET /api/users/me` — profil dan saldo sendiri
- `PUT /api/users/me` — ubah username, email, atau phone
- `GET /api/users/me/mutations` — riwayat mutasi saldo (`page`, `limit`, `type`)

### Owner saja

- `GET /api/users` — daftar user (`page`, `limit`, `role`, `status`, `search`)
- `GET /api/users/:id` — detail user
- `PUT /api/users/:id` — ubah profil, role, atau status
- `DELETE /api/users/:id` — soft-ban (status menjadi `banned`, data dan mutasi tetap ada)
- `POST /api/users/:id/balance` — perubahan saldo yang selalu dicatat sebagai mutasi
- `GET /api/users/:id/mutations` — riwayat mutasi user

Contoh perubahan saldo:

```json
{
  "type": "deposit",
  "direction": "+",
  "amount": 100000,
  "note": "deposit manual",
  "ref_id": "deposit-001"
}
```

`amount` adalah integer Rupiah, bukan floating point. Tipe mutasi: `deposit`, `pembelian`, `refund`; arah: `+` atau `-`.

## Seed owner sekali jalan

Seed script tidak menyimpan password di source code atau git:

```bash
OWNER_USERNAME=jayadana \
OWNER_EMAIL=jayadana@jywa.tech \
OWNER_PHONE=08123456789 \
OWNER_PASSWORD='isi-password-kuat' \
npm run seed:owner
```
