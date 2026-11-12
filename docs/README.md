# Sambung HP ke Laptop (versi GitHub Pages)

Versi statis tanpa server sendiri. Pairing pakai QR sekali scan, lalu chat dan kirim
file langsung antar perangkat lewat WebRTC.

## Alamat

Jika GitHub Pages aktif (Settings → Pages → branch `main`, folder `/docs`), halaman ini ada di
`https://chalidade.github.io/remote-anything/`.

## Cara pakai

1. Buka alamat Pages di laptop. Muncul QR.
2. Scan QR pakai **kamera HP** (terbuka di browser), atau pakai **aplikasi Sambung** untuk backup galeri.
3. Status jadi **Terhubung**. Kirim chat atau file dari mana saja.

Untuk backup dari aplikasi, tekan **Pilih folder** dulu di laptop (Chrome/Edge). File dari HP
langsung ditulis ke folder itu, file yang sudah ada dilewati.

QR berisi ID laptop dan kunci yang disimpan di browser laptop, jadi tetap sama setiap kali
halaman dibuka. "Buat QR baru" mengganti kuncinya sehingga HP lama tidak bisa menyambung lagi.

Kedua perangkat butuh internet saat pairing. HP dan laptop **tidak harus** di Wi-Fi yang sama.

## Cara kerja dan batasannya

- Pairing memakai server signaling publik gratis milik PeerJS (`0.peerjs.com`). Server ini
  hanya bertukar data koneksi, bukan isi chat atau file.
- Setelah tersambung, data mengalir **P2P langsung** antar perangkat.
- Kalau jaringan memblokir koneksi langsung, PeerJS mencoba lewat server TURN publik
  mereka. Bar status menampilkan "lewat server TURN (relay)" jika itu yang terjadi.
  Layanan publik ini gratis tapi tanpa jaminan, jadi bisa saja lambat atau mati.
- Laptop bisa dipakai berkali-kali: kalau HP putus, QR yang sama muncul lagi.

## Pakai server PeerJS sendiri (opsional)

Kalau server publik bermasalah, jalankan server PeerJS sendiri (`npx peer --port 9000`)
lalu buka halaman dengan `?server=host:port`, misalnya
`https://<username>.github.io/sambung-hp/?server=peer.domainku.com:443`.
QR otomatis ikut membawa parameter ini.
