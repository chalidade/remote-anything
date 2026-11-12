# Sambung (aplikasi Android)

Aplikasi Flutter untuk backup galeri dan kirim file dari HP ke laptop yang menjalankan
server Sambung (`server.js` di root repo).

- `lib/pairing.dart`: membaca QR `sambung://pair?...`, mencari alamat laptop yang terjangkau.
- `lib/api.dart`: klien HTTP ke `/api/check` dan `/api/upload` (upload streaming).
- `lib/backup.dart`: memindai galeri (photo_manager), cek file yang belum ada, upload dengan retry.
- `lib/home_screen.dart`, `lib/scan_screen.dart`: tampilan.

Build: `flutter pub get && flutter build apk --release --split-per-abi --target-platform android-arm64`
