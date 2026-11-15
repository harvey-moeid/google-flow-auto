# Worker Operations — Google Flow Auto

Dokumen ini menjelaskan operasi worker setelah Phase 4B dan dashboard Phase 4C. Worker berjalan di host tepercaya yang dikendalikan pemilik; PWA hanya membaca status dan menampilkan instruksi. PWA tidak dapat menyalakan proses OS, membuka browser host, atau mengakses profil Chromium dari HP.

## Prasyarat host

- Host persisten dengan Python sesuai engine/requirements.txt, Playwright Chromium terpasang, dan koneksi HTTPS ke API.
- Disk host terenkripsi pada level OS/volume dan akses filesystem dibatasi ke akun operator.
- Buat engine/.env dari .env.example; isi API_BASE_URL, WORKER_TOKEN, WORKER_ID, FLOW_WORKER_DATA_DIR, dan FLOW_HEADLESS=false secara lokal. Jangan commit file ini.
- WORKER_TOKEN harus sama dengan secret Worker API. Jangan memasukkan token ke PWA, GitHub issue, chat, atau log.
- Pastikan host dan disk mempunyai backup terenkripsi yang dikendalikan pemilik. Backup/restore otomatis belum disediakan aplikasi.

## Jalankan worker

Dari folder engine:

    python -m worker.main --serve

Worker akan polling queue, melaporkan heartbeat proses setiap sekitar 30 detik, dan melaporkan status stopping saat shutdown normal. Satu global lease di API tetap menjadi otoritas serialisasi; heartbeat worker hanya observabilitas dan tidak mengubah queue.

Untuk smoke satu job:

    python -m worker.main --once

Mode default tanpa --serve atau --once hanya menjalankan satu job lokal; ia tidak mengonsumsi API queue.

## Enrollment manual satu akun

1. Hentikan proses --serve dengan Ctrl+C. Jangan membuka profil yang sama dari dua proses Chromium.
2. Jalankan satu akun yang dipilih, misalnya:

       python -m worker.main --enroll acct-01

3. Selesaikan login secara manual di browser yang terbuka. Aplikasi tidak mengetik password, membaca cookie, melewati CAPTCHA, atau mengonfirmasi login secara otomatis.
4. Ketik ya pada terminal hanya setelah pemilik memastikan login selesai. Browser ditutup dahulu agar perubahan profil tersimpan; baru kemudian status ready dikirim ke API.
5. Jalankan kembali:

       python -m worker.main --serve

Jika enrollment dibatalkan, status akun tidak berubah. Jika API menolak readiness (misalnya akun sedang dipakai job), periksa status job dan ulangi setelah aman.

## Dashboard monitoring

Tab Accounts memuat GET /api/workers dan refresh otomatis setiap 15 detik. Dashboard menampilkan:

- Worker online/offline berdasarkan heartbeat 90 detik.
- State proses (idle, busy, stopping).
- Jumlah direktori profil slot-01 sampai slot-10 yang terdeteksi.
- Disk bebas/total dan indikator disk rendah di bawah 2 GiB.
- Waktu heartbeat terakhir.

Data ini tidak membuktikan bahwa Google login masih valid, browser siap, backup berhasil, atau live adapter berfungsi. Jumlah profil hanya menghitung direktori lokal yang ada, bukan memeriksa integritasnya. Worker status tidak pernah menjadi syarat claim job.

## Keamanan dan pemulihan

- Simpan profil browser hanya pada disk host terenkripsi. Jangan upload profil, cookies, session state, atau kredensial ke GitHub, D1, R2, atau CI artifact.
- Backup harus dienkripsi sebelum keluar dari host dan hanya dapat dipulihkan oleh pemilik. Uji restore pada host terpisah sebelum mengandalkannya.
- Jangan jalankan dua worker yang mengakses folder profil sama. Queue API mencegah dua job global aktif, tetapi tidak mengelola proses Chromium yang dibuka manual di luar worker.
- Jika worker offline, periksa host, koneksi, disk, dan token secret secara lokal. Status offline sendiri tidak membatalkan job; stale lease recovery ditangani API.
- Jika job waiting_for_user, lakukan enrollment ulang pada slot terkait, pastikan akun ready, lalu gunakan tombol Lanjutkan pada detail job.
- Live engines tetap nonaktif. Hanya dry-run yang terverifikasi dalam scaffold saat ini.

## Batasan yang belum selesai

- Belum ada remote start/stop service manager atau daemon supervisor dari PWA.
- Belum ada enkripsi profil yang dikelola aplikasi, backup/restore otomatis, atau uji pemulihan.
- Belum ada pemeriksaan login Google otomatis; status ready adalah konfirmasi manual pemilik.
- Belum ada integrasi live Google Flow yang diverifikasi atau deployment staging nyata.
