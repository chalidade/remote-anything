import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import 'peer_link.dart';

/// Data pairing yang dibaca dari QR di laptop. Dua jenis:
/// - server lokal: sambung://pair?hosts=..&port=..&token=..&name=..
/// - halaman web (GitHub Pages): `https://…/#idLaptop.kunci` (opsional `?server=host:port`)
class PairInfo {
  PairInfo({
    this.kind = 'server',
    this.hosts = const [],
    this.port = 0,
    this.token = '',
    required this.name,
    this.lastHost,
    this.peerId = '',
    this.peerKey = '',
    this.peerServer = PeerServer.cloud,
  });

  final String kind; // 'server' | 'web'
  final List<String> hosts;
  final int port;
  final String token;
  final String name;
  String? lastHost; // alamat yang terakhir berhasil
  final String peerId;
  final String peerKey;
  final PeerServer peerServer;

  bool get isWeb => kind == 'web';

  static PairInfo? fromQr(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null) return null;
    if (uri.scheme == 'sambung' && uri.host == 'pair') {
      final q = uri.queryParameters;
      final hosts = (q['hosts'] ?? '').split(',').where((h) => h.isNotEmpty).toList();
      final port = int.tryParse(q['port'] ?? '');
      final token = q['token'];
      if (hosts.isEmpty || port == null || token == null || token.isEmpty) return null;
      return PairInfo(hosts: hosts, port: port, token: token, name: q['name'] ?? 'Laptop');
    }
    if ((uri.scheme == 'https' || uri.scheme == 'http') && uri.fragment.isNotEmpty) {
      final parts = uri.fragment.split('.');
      if (parts.length != 2 || !parts[0].startsWith('sambung-hp-') || parts[1].isEmpty) return null;
      var server = PeerServer.cloud;
      final custom = uri.queryParameters['server'];
      if (custom != null && custom.isNotEmpty) {
        final hp = custom.split(':');
        server = PeerServer(host: hp[0], port: hp.length > 1 ? int.tryParse(hp[1]) ?? 443 : 443, secure: uri.scheme == 'https');
      }
      return PairInfo(kind: 'web', name: 'Laptop (${uri.host})', peerId: parts[0], peerKey: parts[1], peerServer: server);
    }
    return null;
  }

  Map<String, dynamic> toJson() => {
        'kind': kind,
        'hosts': hosts,
        'port': port,
        'token': token,
        'name': name,
        'lastHost': lastHost,
        'peerId': peerId,
        'peerKey': peerKey,
        'peerServer': peerServer.toJson(),
      };

  static PairInfo fromJson(Map<String, dynamic> j) => PairInfo(
        kind: j['kind'] as String? ?? 'server',
        hosts: List<String>.from(j['hosts'] as List? ?? const []),
        port: j['port'] as int? ?? 0,
        token: j['token'] as String? ?? '',
        name: j['name'] as String,
        lastHost: j['lastHost'] as String?,
        peerId: j['peerId'] as String? ?? '',
        peerKey: j['peerKey'] as String? ?? '',
        peerServer: j['peerServer'] == null ? PeerServer.cloud : PeerServer.fromJson(Map<String, dynamic>.from(j['peerServer'] as Map)),
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
