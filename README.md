# Sistem Pencatatan Debit (SPAM)

Aplikasi web pencatatan debit mata air / pengolahan: ambang persegi, V-notch, Cipolletti, dan UFM.
Fitur: login multi-operator, rekap bulanan & tahunan, grafik, ekspor Excel (.xlsx).

## Menjalankan di VS Code
1. Pasang **Node.js 18+** (https://nodejs.org).
2. Buka folder ini di VS Code (`File > Open Folder`).
3. Buka Terminal (`Ctrl+\``) lalu jalankan: `node server.js` (atau tekan F5).
4. Buka http://localhost:3000
5. Login awal: **admin / admin123** (atau sesuai `.env`). Segera ganti di tab *Akun*.

Tidak perlu `npm install` — server tidak memakai dependensi. Ekspor Excel memakai pustaka SheetJS dari CDN (perlu internet saat membuka halaman).

## Struktur
- `server.js` — server HTTP + API + penyimpanan JSON (`data/db.json`), password di-hash (scrypt), sesi cookie.
- `public/index.html` — seluruh antarmuka (input, titik ukur, riwayat, laporan, akun).
- `data/db.json` — dibuat otomatis; **backup file ini secara rutin**.

## Peran
- **Admin**: kelola titik ukur & akun, hapus data apa pun.
- **Operator**: input pengukuran, hapus data miliknya sendiri.

## Rumus (h, b, p dalam meter → Q dalam m³/detik)
- Persegi: Q = ⅔·Cd·√(2g)·be·he^1,5; be=b+0,0012; he=h+0,001; Cd=0,602+0,083·h/p (acuan SNI 8137:2015)
- V-notch: Q = 8/15·Cd·√(2g)·tan(θ/2)·he^2,5; Cd default 0,578
- Cipolletti: Q = 1,86·b·h^1,5 (acuan SNI 03-6381-2000)
- UFM: debit diinput langsung.
**Verifikasi rumus/koefisien dengan dokumen SNI & pedoman PUPR yang berlaku sebelum dipakai resmi.** Rumus ada di fungsi `calc()` dan `warnH()` pada `public/index.html`.

## Deploy
- VPS/server kantor: `node server.js` di belakang Nginx + HTTPS, set `COOKIE_SECURE=1`. Gunakan PM2/systemd agar selalu hidup.
- Docker: `docker build -t debit-spam .` lalu `docker run -p 3000:3000 -v debit-data:/app/data debit-spam`.
- Untuk skala besar/banyak titik, pertimbangkan migrasi penyimpanan ke PostgreSQL/SQLite.
