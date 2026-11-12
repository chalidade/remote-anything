import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'api.dart';

enum JobPhase { idle, scanning, uploading, done, failed }

/// Status pekerjaan backup / kirim file, dipantau oleh UI.
class JobState {
  JobPhase phase = JobPhase.idle;
  String title = '';
  int totalFiles = 0; // file yang diperiksa
  int toSend = 0; // file yang perlu dikirim
  int sentFiles = 0;
  int skipped = 0;
  int failed = 0;
  int totalBytes = 0;
  int sentBytes = 0;
  String current = '';
  String? error;
  final List<String> failures = [];

  double get progress => totalBytes == 0 ? 0 : (sentBytes / totalBytes).clamp(0, 1);
  bool get running => phase == JobPhase.scanning || phase == JobPhase.uploading;
}

class _Item {
  _Item(this.file, this.relPath, this.size, this.mtimeMs);
  final File file;
  final String relPath;
  final int size;
  final int? mtimeMs;
}

class BackupService extends ChangeNotifier {
  JobState state = JobState();
  bool _cancel = false;

  void cancel() => _cancel = true;

  void _reset(String title) {
    state = JobState()
      ..title = title
      ..phase = JobPhase.scanning;
    _cancel = false;
    notifyListeners();
  }

  /// Backup galeri (foto, dan video jika diizinkan) ke laptop. File yang sudah ada dilewati.
  Future<void> backupGallery(LaptopClient client, {bool includeVideos = true}) async {
    _reset('Backup galeri');
    await WakelockPlus.enable();
    try {
      final perm = await PhotoManager.requestPermissionExtend();
      if (!perm.hasAccess) throw 'Izin akses galeri ditolak. Buka Pengaturan dan izinkan akses foto & video.';

      final paths = await PhotoManager.getAssetPathList(
        type: includeVideos ? RequestType.common : RequestType.image,
        onlyAll: true,
      );
      if (paths.isEmpty) {
        state.phase = JobPhase.done;
        return;
      }
      final all = paths.first;
      final count = await all.assetCountAsync;
      const pageSize = 200;
      final need = <_Item>[];

      for (var page = 0; page * pageSize < count; page++) {
        if (_cancel) throw 'Dibatalkan';
        final assets = await all.getAssetListPaged(page: page, size: pageSize);
        final batch = <_Item>[];
        for (final a in assets) {
          final f = await a.originFile;
          if (f == null || !await f.exists()) continue;
          final name = await a.titleAsync;
          final dir = (a.relativePath ?? '').replaceAll(RegExp(r'/+$'), '');
          final rel = dir.isEmpty ? name : '$dir/$name';
          batch.add(_Item(f, rel, await f.length(), a.createDateTime.millisecondsSinceEpoch));
        }
        final needIdx = await client.check([for (final b in batch) (path: b.relPath, size: b.size)]);
        for (var i = 0; i < batch.length; i++) {
          if (needIdx.contains(i)) {
            need.add(batch[i]);
          } else {
            state.skipped++;
          }
        }
        state.totalFiles += batch.length;
        state.current = 'Memeriksa ${state.totalFiles} dari $count file…';
        notifyListeners();
      }
      await _uploadAll(client, need, send: false);
    } catch (e) {
      _fail(e);
    } finally {
      await WakelockPlus.disable();
      notifyListeners();
    }
  }

  /// Kirim file pilihan ke folder "Kiriman" di laptop.
  Future<void> sendFiles(LaptopClient client, List<File> files) async {
    _reset('Kirim file');
    await WakelockPlus.enable();
    try {
      final items = <_Item>[];
      for (final f in files) {
        items.add(_Item(f, f.uri.pathSegments.last, await f.length(), null));
      }
      state.totalFiles = items.length;
      await _uploadAll(client, items, send: true);
    } catch (e) {
      _fail(e);
    } finally {
      await WakelockPlus.disable();
      notifyListeners();
    }
  }

  Future<void> _uploadAll(LaptopClient client, List<_Item> items, {required bool send}) async {
    state
      ..phase = JobPhase.uploading
      ..toSend = items.length
      ..totalBytes = items.fold(0, (s, i) => s + i.size);
    notifyListeners();

    var lastNotify = DateTime.now();
    for (final item in items) {
      if (_cancel) throw 'Dibatalkan';
      state.current = item.relPath.split('/').last;
      notifyListeners();
      final base = state.sentBytes;
      var attempt = 0;
      while (true) {
        try {
          final saved = await client.upload(item.file, item.relPath, size: item.size, mtimeMs: item.mtimeMs, send: send,
              onProgress: (sent) {
            state.sentBytes = base + sent;
            final now = DateTime.now();
            if (now.difference(lastNotify).inMilliseconds > 150) {
              lastNotify = now;
              notifyListeners();
            }
          });
          if (saved) {
            state.sentFiles++;
          } else {
            state.skipped++;
          }
          state.sentBytes = base + item.size;
          break;
        } catch (e) {
          attempt++;
          if (attempt < 3 && !_cancel) {
            state.sentBytes = base;
            await Future.delayed(Duration(seconds: attempt * 2));
            continue;
          }
          state.failed++;
          state.failures.add('${item.relPath}: $e');
          state.sentBytes = base + item.size;
          break;
        }
      }
      notifyListeners();
    }
    state
      ..phase = JobPhase.done
      ..current = '';
  }

  void _fail(Object e) {
    state
      ..phase = JobPhase.failed
      ..error = e is SocketException ? 'Koneksi ke laptop terputus.' : e.toString();
  }
}
