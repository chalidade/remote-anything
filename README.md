# Sambung: HP ↔ laptop

Kumpulan alat untuk menyambungkan HP dan laptop: backup galeri HP ke laptop lewat Wi-Fi,
serta chat dan kirim file dua arah dari browser.

| Bagian | Isi | Butuh |
|---|---|---|
| `server.js`, `backup-api.js`, `public/` | Server di laptop: penerima backup + web app chat/kirim file | Node.js 18+ di laptop |
| `android-app/` | Aplikasi Android **Sambung** (Flutter) untuk backup galeri | APK di [Releases](../../releases) |
| `docs/` | Versi web statis (GitHub Pages), tanpa server sendiri | Internet saat pairing |

## Mulai cepat: backup HP ke laptop

**Di laptop**

```bash
git clone https://github.com/chalidade/remote-anything.git
cd remote-anything
npm start            # atau: node server.js
```

Di Windows bisa juga klik dua kali `start-windows.bat`.
Lalu buka `http://localhost:8080/backup.html`. Muncul QR pairing.

**Di HP**

1. Unduh APK dari halaman [Releases](../../releases) (`Sambung-…-arm64.apk`).
   Kalau gagal dipasang, pakai versi `universal`.
2. Pasang APK (izinkan "Instal dari sumber tidak dikenal"). Kalau Play Protect memberi
   peringatan, pilih "Tetap instal".
3. Buka **Sambung**, tekan **Pair dengan laptop**, scan QR di laptop.
4. Tekan **Backup galeri sekarang**.

HP dan laptop harus di Wi-Fi yang sama (atau laptop tersambung ke hotspot HP).
Kalau HP tidak bisa menemukan laptop, izinkan Node.js di firewall laptop (jaringan Private).

### Hasil backup

- Disimpan di `~/SambungBackup/<nama HP>/` dengan struktur folder seperti di HP,
  misalnya `DCIM/Camera/IMG_20261112.jpg`.
  Ganti lokasi: `BACKUP_DIR=/path/folder npm start` (Windows PowerShell: `$env:BACKUP_DIR="D:\Backup"; npm start`).
- File yang sudah ada (nama dan ukuran sama) dilewati, jadi backup berikutnya hanya mengirim yang baru.
- "Kirim file ke laptop" menyimpan ke `~/SambungBackup/<nama HP>/Kiriman/`.
- Kunci pairing disimpan di `~/.sambung-hp.json`. Hapus file itu untuk mencabut semua HP yang sudah pair.

### Batasan versi 1.0

- Backup berjalan saat aplikasi terbuka (layar dijaga tetap menyala). Backup otomatis di latar belakang belum ada.
- APK ditandatangani dengan kunci debug: cukup untuk dipasang sendiri, belum untuk Play Store.

## Chat dan kirim file lewat browser

Tanpa aplikasi apa pun di HP:

1. Jalankan server di laptop (`npm start`), buka `http://localhost:8080`. Muncul QR.
2. Scan QR pakai kamera HP, buka tautannya di browser.
3. Status jadi **Terhubung**. Kirim chat atau file dari dua arah.

Data dikirim P2P lewat WebRTC di jaringan lokal. Kalau P2P gagal dalam 10 detik, otomatis
pindah ke mode relay lewat server laptop.

Versi tanpa server (GitHub Pages) ada di `docs/`; lihat [docs/README.md](docs/README.md).

## Kenapa bukan Wi-Fi Direct / Wi-Fi Aware / Bluetooth?

Browser tidak punya API untuk Wi-Fi Direct maupun Wi-Fi Aware, dan Web Bluetooth tidak bisa
dipakai untuk menyambungkan dua browser. Wi-Fi Direct asli memerlukan aplikasi native
(`WifiP2pManager` di Android), jadi itu kandidat fitur aplikasi Android berikutnya.

## Build ulang APK

```bash
cd android-app
flutter pub get
flutter build apk --release --split-per-abi --target-platform android-arm64
```
