# 🤖 NOVA WhatsApp Bot (Pairing Code + Gemini AI)

Integrasi WhatsApp untuk chatbot AI **NOVA** yang dirancang ringan dan stabil untuk berjalan **24/7 di VPS** menggunakan **WhatsApp Pairing Code** (`@whiskeysockets/baileys` v7) — tanpa perlu memindai QR Code dan tanpa browser Chromium/Puppeteer.

Bot ini menggunakan konfigurasi model AI, rantai *failover* otomatis (`gemini-3.8-flash` ➔ `gemini-3.7-flash` ➔ `gemini-3.5-flash` ➔ `gemini-3.5-flash-lite` ➔ `gemini-flash-latest`), kepribadian *system prompt*, serta skema database (`conversations` & `messages`) yang sama dengan aplikasi web NOVA.

---

## ✨ Fitur Utama

- **Autentikasi Pairing Code 8 Karakter (`XXXX-XXXX`)**: Mudah ditautkan lewat terminal SSH VPS cukup dengan nomor WhatsApp.
- **Model AI & Failover Sama Persis**: Menggunakan `GEMINI_MODEL=gemini-3.8-flash` dan otomatis berpindah ke model cadangan saat rate limit atau gangguan API.
- **Ringan untuk VPS**: Berbasis WebSocket murni (~50–150 MB RAM), cocok untuk VPS Linux 512 MB–1 GB RAM sekalipun.
- **Auto-Reconnect 24/7**: Otomatis menyambung kembali dengan *exponential backoff* saat koneksi putus, serta menangani `restartRequired (515)` setelah pairing selesai.
- **Riwayat Percakapan Persisten**: Mendukung **Turso Cloud (LibSQL)** (bisa berbagi database yang sama dengan web Vercel), **SQLite lokal (`node:sqlite`)**, atau **JSON fallback** jika memakai Node 20.
- **Kontrol Grup & Keamanan**: Mode grup (`off`, `mention`, `all`), *whitelist* nomor (`ALLOWED_NUMBERS`), antrean berurutan per chat, dan *cooldown* anti-spam.
- **Format Rapi di WhatsApp**: Mengonversi respons Markdown (heading, `**bold**`, link, strikethrough) menjadi format WhatsApp sambil menjaga isi blok kode tetap utuh, serta memecah jawaban panjang secara otomatis.

---

## 📋 Prasyarat VPS

- **OS**: Ubuntu / Debian / VPS Linux (atau Windows/macOS untuk uji coba lokal)
- **Node.js**: Versi **20.x atau 22.x+** (`node:sqlite` aktif otomatis di Node >= 22.5)
- **API Key**: `GEMINI_API_KEY` dari [Google AI Studio](https://aistudio.google.com/app/apikey)

---

## 🚀 Instalasi & Pairing Pertama Kali di VPS

### 1. Masuk ke folder `whatsapp-bot` dan instal dependensi
```bash
cd whatsapp-bot
npm install
```

### 2. Buat file konfigurasi `.env`
```bash
cp .env.example .env
nano .env
```
Isi minimal variabel berikut di `.env`:
```env
GEMINI_API_KEY=AIzaSy_API_KEY_KAMU
GEMINI_MODEL=gemini-3.8-flash
WA_PHONE_NUMBER=6281234567890
```
> **Tips**: Jika folder ini dijalankan langsung di dalam repositori utama yang sudah memiliki `../.env.local`, key yang belum diisi di `whatsapp-bot/.env` akan otomatis membaca fallback dari `../.env.local`. Untuk deploy mandiri di VPS, isi lengkap di `whatsapp-bot/.env`.

### 3. Jalankan Pairing Code secara interaktif
Jalankan langsung lewat SSH:
```bash
npm start
```
*(Atau gunakan `npm run pair` jika ingin memaksa input nomor secara interaktif saat belum terhubung.)*

Bot akan menampilkan kode pairing 8 karakter di terminal:
```text
====================================================
  KODE PAIRING WHATSAPP: 1234-5678
====================================================
```

### 4. Masukkan kode di aplikasi WhatsApp HP Anda
1. Buka **WhatsApp** di ponsel yang ingin dijadikan bot.
2. Buka **Setelan (Settings)** ➔ **Perangkat Tertaut (Linked Devices)**.
3. Ketuk **Tautkan Perangkat (Link a Device)**.
4. Di bagian bawah layar kamera QR, pilih **Tautkan dengan nomor telepon saja (Link with phone number instead)**.
5. Masukkan kode `XXXX-XXXX` yang muncul di terminal VPS.
6. Tunggu beberapa detik — setelah berhasil, folder sesi `auth_info/` tersimpan otomatis dan Anda tidak perlu pairing ulang saat restart.

---

## 🖥️ Menjalankan 24/7 di VPS (Produksi)

Setelah proses pairing pertama selesai dan muncul log `Terhubung ke WhatsApp!`, hentikan proses terminal (`Ctrl + C`) lalu jalankan di latar belakang dengan salah satu cara berikut:

### Opsi A: Menggunakan PM2 (Direkomendasikan)
```bash
sudo npm install -g pm2
cd whatsapp-bot
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```
> **Penting**: Jangan ubah `instances: 1` atau `exec_mode: "fork"` di `ecosystem.config.cjs`. Sesi WhatsApp Baileys tidak boleh dijalankan dalam mode cluster ganda karena akan memicu error `440 connectionReplaced`.

Perintah PM2 yang sering dipakai:
```bash
pm2 logs nova-whatsapp-bot
pm2 restart nova-whatsapp-bot
pm2 status
```

### Opsi B: Menggunakan `systemd` (Ubuntu/Debian)
1. Salin `whatsapp-bot.service.example` ke `/etc/systemd/system/nova-wa-bot.service`.
2. Ubah `User` dan `WorkingDirectory` sesuai direktori proyek Anda di VPS.
3. Aktifkan layanan:
```bash
sudo systemctl daemon-reload
sudo systemctl enable nova-wa-bot
sudo systemctl start nova-wa-bot
sudo journalctl -u nova-wa-bot -f
```

### Opsi C: Menggunakan Docker
Lakukan pairing terlebih dahulu atau mount folder `auth_info` secara persisten:
```bash
docker build -t nova-whatsapp-bot .
docker run -it --rm -v "$(pwd)/auth_info:/app/auth_info" --env-file .env nova-whatsapp-bot
# Setelah status terhubung, tekan Ctrl+C lalu jalankan mode daemon (-d):
docker run -d --name nova-wa-bot --restart unless-stopped \
  -v "$(pwd)/auth_info:/app/auth_info" \
  -v "$(pwd)/.tmp:/app/.tmp" \
  --env-file .env \
  nova-whatsapp-bot
```

---

## 💬 Perintah Chatbot di WhatsApp

Dengan prefix default `BOT_PREFIX=!`:

| Perintah | Fungsi |
| :--- | :--- |
| `!help` atau `!menu` | Menampilkan daftar perintah dan informasi singkat bot |
| `!reset` atau `!clear` | Menghapus riwayat konteks percakapan AI pada chat tersebut |
| `!status` | Menampilkan model AI aktif, database engine, uptime, dan jumlah pesan tersimpan |
| `!ai <pesan>` / `!nova <pesan>` | Memanggil bot secara eksplisit (berguna di grup dengan `GROUP_MODE=mention`) |

Pada **Direct Message (PM)**, pengguna dapat langsung mengirim chat biasa tanpa prefix.
Pada **Grup WhatsApp**, perilaku bot diatur lewat `GROUP_MODE`:
- `off`: bot mengabaikan semua pesan grup.
- `mention` *(default)*: bot merespons jika di-`@mention`, di-reply pesannya, atau dipanggil dengan `!ai` / `!nova` / perintah bot.
- `all`: bot merespons seluruh pesan teks di grup.

---

## 🗄️ Sinkronisasi Database dengan Web Chatbot (Opsional)

Secara default, bot menyimpan riwayat chat ke SQLite lokal di `whatsapp-bot/.tmp/nova_whatsapp.db`.
Jika Anda ingin riwayat percakapan WhatsApp juga tercatat di **Turso Cloud** yang sama dengan web chatbot Vercel:
1. Isi `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN` di `whatsapp-bot/.env`.
2. Setiap chat WhatsApp disimpan dengan ID percakapan `wa_<remoteJid>` agar tidak bertabrakan dengan sesi web.

---

## 🛠️ Troubleshooting

- **Gagal pairing atau kode kadaluarsa**:
  Pastikan format `WA_PHONE_NUMBER` berupa kode negara + nomor tanpa `+` atau spasi (contoh: `6281234567890`). Jangan meminta kode pairing berkali-kali dalam waktu berdekatan agar tidak terkena pembatasan sementara (HTTP 429) dari WhatsApp.
- **Sesi Logout (`DisconnectReason.loggedOut` / status 401)**:
  Sesi dihapus dari HP ("Keluar dari perangkat tertaut"). Jalankan:
  ```bash
  npm run reset-auth
  npm start
  ```
  Lalu lakukan pairing ulang.
- **Error `440 connectionReplaced`**:
  Ada dua proses bot berjalan bersamaan memakai sesi `auth_info` yang sama (misalnya di PM2 dan terminal manual). Hentikan salah satunya.
- **Status `515 restartRequired` setelah pairing**:
  Normal terjadi sesaat setelah kode pairing dimasukkan di HP; bot otomatis melakukan reconnect dalam 1 detik.
- **Endpoint Health Check**:
  Atur `HEALTH_PORT=3001` di `.env` jika Anda membutuhkan endpoint `GET http://127.0.0.1:3001/health` untuk pemantauan PM2/Docker/Nginx.
