# Kopi QR — pesan lewat QR + notifikasi pesanan siap

## Jalankan (butuh Node.js 22.13 ke atas; tidak perlu compile apa pun)
```bash
npm install
cp .env.example .env        # isi ADMIN_PASSWORD
npm run vapid               # salin public & private key ke .env (untuk Web Push)
npm start
```
- Cetak QR meja: http://localhost:3000/admin/qr (user bebas, password = ADMIN_PASSWORD)
- Dashboard barista: http://localhost:3000/barista
- Menu customer: dari QR, bentuknya `/menu.html?meja=<token>`

## Tes notifikasi / QRIS
Web Push dan webhook butuh HTTPS. Untuk tes lokal: `ngrok http 3000`, lalu isi `APP_URL` dengan URL ngrok.
QRIS: isi `MIDTRANS_SERVER_KEY` (sandbox), set Payment Notification URL di dashboard Midtrans ke
`https://<domain>/api/midtrans/webhook`. Opsi "QRIS" muncul otomatis kalau key terisi.

## Alur
Scan QR → pilih menu → pesan (kasir/QRIS) → halaman status (realtime) → barista ubah status →
"Siap diambil" mengirim Web Push ke HP customer.

## Belum ada
Login multi-user, laporan penjualan, edit harga/menu (sekarang lewat DB / `server.js` seed), rate limiting.
