import 'dart:io';

/// Jawaban "file mana yang belum ada di laptop".
class CheckResult {
  CheckResult(this.need, {this.canSave = true});
  final Set<int> need;

  /// false jika laptop belum memilih folder simpan (mode halaman web).
  final bool canSave;
}

/// Jalur kirim ke laptop: server lokal (HTTP) atau halaman web (WebRTC lewat PeerJS).
abstract class Transport {
  Future<CheckResult> check(List<({String path, int size})> files);

  /// Mengembalikan true jika disimpan, false jika dilewati karena sudah ada.
  Future<bool> upload(File file, String relPath, {required int size, int? mtimeMs, bool send = false, void Function(int sent)? onProgress});

  void close();
}
