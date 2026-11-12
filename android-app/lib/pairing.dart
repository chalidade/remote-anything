import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

/// Data pairing yang dibaca dari QR di laptop: sambung://pair?hosts=..&port=..&token=..&name=..
class PairInfo {
  PairInfo({required this.hosts, required this.port, required this.token, required this.name, this.lastHost});

  final List<String> hosts;
  final int port;
  final String token;
  final String name;
  String? lastHost; // alamat yang terakhir berhasil

  static PairInfo? fromQr(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null || uri.scheme != 'sambung' || uri.host != 'pair') return null;
    final q = uri.queryParameters;
    final hosts = (q['hosts'] ?? '').split(',').where((h) => h.isNotEmpty).toList();
    final port = int.tryParse(q['port'] ?? '');
    final token = q['token'];
    if (hosts.isEmpty || port == null || token == null || token.isEmpty) return null;
    return PairInfo(hosts: hosts, port: port, token: token, name: q['name'] ?? 'Laptop');
  }

  Map<String, dynamic> toJson() => {'hosts': hosts, 'port': port, 'token': token, 'name': name, 'lastHost': lastHost};

  static PairInfo fromJson(Map<String, dynamic> j) => PairInfo(
        hosts: List<String>.from(j['hosts'] as List),
        port: j['port'] as int,
        token: j['token'] as String,
        name: j['name'] as String,
        lastHost: j['lastHost'] as String?,
      );

  static const _key = 'pair_info';

  static Future<PairInfo?> load() async {
    final p = await SharedPreferences.getInstance();
    final s = p.getString(_key);
    if (s == null) return null;
    try {
      return fromJson(jsonDecode(s) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_key, jsonEncode(toJson()));
  }

  static Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_key);
  }

  /// Urutan alamat yang dicoba: yang terakhir berhasil lebih dulu.
  List<String> get candidates => [?lastHost, ...hosts.where((h) => h != lastHost)];
}

class HelloResult {
  HelloResult(this.host, this.name);
  final String host;
  final String name;
}

/// Mencoba semua alamat laptop secara paralel dan mengembalikan yang pertama menjawab.
Future<HelloResult> findLaptop(PairInfo info, {Duration timeout = const Duration(seconds: 4)}) async {
  final completer = Completer<HelloResult>();
  var pending = info.candidates.length;
  String? lastError;
  for (final host in info.candidates) {
    () async {
      final client = HttpClient()..connectionTimeout = timeout;
      try {
        final req = await client.getUrl(Uri.parse('http://$host:${info.port}/api/hello')).timeout(timeout);
        req.headers.set('X-Token', info.token);
        final res = await req.close().timeout(timeout);
        final body = await res.transform(utf8.decoder).join();
        if (res.statusCode == 401) throw const HttpException('Kunci pairing ditolak. Scan ulang QR di laptop.');
        if (res.statusCode != 200) throw HttpException('Laptop menjawab ${res.statusCode}');
        final j = jsonDecode(body) as Map<String, dynamic>;
        if (j['app'] != 'sambung') throw const HttpException('Bukan server Sambung');
        if (!completer.isCompleted) completer.complete(HelloResult(host, j['name'] as String? ?? info.name));
      } catch (e) {
        lastError = e is HttpException ? e.message : null;
      } finally {
        client.close(force: true);
        pending--;
        if (pending == 0 && !completer.isCompleted) {
          completer.completeError(lastError ??
              'Laptop tidak terjangkau. Pastikan server Sambung jalan dan HP satu Wi-Fi dengan laptop.');
        }
      }
    }();
  }
  return completer.future;
}
