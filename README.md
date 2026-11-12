# Sambung: HP ↔ laptop

Kumpulan alat untuk menyambungkan HP dan laptop: backup galeri HP ke laptop,
serta chat dan kirim file dua arah dari browser.

| Bagian | Isi | Butuh |
|---|---|---|
| `server.js`, `backup-api.js`, `public/` | Server di laptop: penerima backup + web app chat/kirim file | Node.js 18+ di laptop |
| `android-app/`, `apk/` | Aplikasi Android **Sambung** (Flutter) untuk backup galeri | APK di folder [`apk/`](apk) |
| `docs/` | Halaman web (GitHub Pages): penerima backup tanpa server + chat/kirim file | Chrome/Edge, internet |

## Mulai cepat: backup HP ke laptop

Pasang APK di HP dulu: unduh [`apk/Sambung-1.1.0-arm64.apk`](apk/Sambung-1.1.0-arm64.apk)
(buka tautannya di HP lalu tekan *Download*), pasang, dan izinkan "Instal dari sumber tidak dikenal".
Kalau Play Protect memberi peringatan, pilih "Tetap instal".

### Cara A: tanpa install apa pun di laptop

1. Di laptop, buka **https://chalidade.github.io/remote-anything/** di Chrome atau Edge.
2. Tekan **Pilih folder** dan pilih folder tujuan backup (misalnya `D:\Backup HP`).
3. Di HP, buka aplikasi **Sambung** → **Pair dengan laptop** → scan QR di halaman tadi.
4. Tekan **Backup galeri sekarang**.

HP dan laptop boleh beda jaringan, tapi keduanya butuh internet. Halaman laptop harus tetap
terbuka selama backup. QR-nya tetap sama setiap kali halaman dibuka, jadi HP tidak perlu scan ulang;
tekan "Buat QR baru" untuk mencabut akses HP lama.

### Cara B: server di laptop (tanpa internet)

```bash
git clone https://github.com/chalidade/remote-anything.git
cd remote-anything
npm start            # atau klik dua kali start-windows.bat
```

Buka `http://localhost:8080/backup.html`, lalu scan QR-nya dari aplikasi. HP dan laptop harus di
Wi-Fi yang sama (atau laptop tersambung ke hotspot HP). Kalau HP tidak bisa menemukan laptop,
izinkan Node.js di firewall laptop (jaringan Private).

### Hasil backup

- Cara A: disimpan di folder pilihanmu, subfolder `<nama HP>/`. Cara B: di `~/SambungBackup/<nama HP>/`.
  Struktur foldernya sama seperti di HP,
  misalnya `DCIM/Camera/IMG_20261112.jpg`.
  Ganti lokasi: `BACKUP_DIR=/path/folder npm start` (Windows PowerShell: `$env:BACKUP_DIR="D:\Backup"; npm start`).
- File yang sudah ada (nama dan ukuran sama) dilewati, jadi backup berikutnya hanya mengirim yang baru.
- "Kirim file ke laptop" menyimpan ke subfolder `<nama HP>/Kiriman/`.
- Cara B: kunci pairing disimpan di `~/.sambung-hp.json`. Hapus file itu untuk mencabut semua HP yang sudah pair.

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

Versi tanpa server (GitHub Pages) langsung bisa dipakai di **https://chalidade.github.io/remote-anything/** (kode di `docs/`).

## Kenapa bukan Wi-Fi Direct / Wi-Fi Aware / Bluetooth?

Browser tidak punya API untuk Wi-Fi Direct maupun Wi-Fi Aware, dan Web Bluetooth tidak bisa
dipakai untuk menyambungkan dua browser. Wi-Fi Direct asli memerlukan aplikasi native
(`WifiP2pManager` di Android), jadi itu kandidat fitur aplikasi Android berikutnya.

## Pengujian

- `android-app/integration_test/peer_test.dart`: menguji koneksi aplikasi ↔ halaman web (PeerJS + WebRTC),
  dijalankan sebagai aplikasi Linux desktop terhadap server PeerJS lokal dan halaman `docs/` di Chromium.

## Build ulang APK

```bash
cd android-app
flutter pub get
flutter build apk --release --split-per-abi --target-platform android-arm64
```
