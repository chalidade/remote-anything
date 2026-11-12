import 'dart:convert';
import 'dart:io';

import 'transport.dart';

/// Klien HTTP ke server Sambung di laptop.
class LaptopClient implements Transport {
  LaptopClient({required this.host, required this.port, required this.token, required this.device});

  final String host;
  final int port;
  final String token;
  final String device;
  final HttpClient _http = HttpClient()..connectionTimeout = const Duration(seconds: 8);

  Uri _u(String path, [Map<String, String>? q]) => Uri(scheme: 'http', host: host, port: port, path: path, queryParameters: q);

  void _headers(HttpClientRequest r) {
    r.headers.set('X-Token', token);
    r.headers.set('X-Device', Uri.encodeComponent(device));
  }

  Future<Map<String, dynamic>> _readJson(HttpClientResponse res) async {
    final body = await res.transform(utf8.decoder).join();
    final j = body.isEmpty ? <String, dynamic>{} : jsonDecode(body) as Map<String, dynamic>;
    if (res.statusCode != 200) throw HttpException(j['error']?.toString() ?? 'HTTP ${res.statusCode}');
    return j;
  }

  /// Mengembalikan indeks file yang belum ada di laptop.
  @override
  Future<CheckResult> check(List<({String path, int size})> files) async {
    final req = await _http.postUrl(_u('/api/check'));
    _headers(req);
    req.headers.contentType = ContentType.json;
    req.write(jsonEncode({'files': files.map((f) => {'path': f.path, 'size': f.size}).toList()}));
    final j = await _readJson(await req.close());
    return CheckResult((j['need'] as List).cast<int>().toSet());
  }

  /// Upload satu file secara streaming (aman untuk video besar).
  /// Mengembalikan true jika disimpan, false jika dilewati karena sudah ada.
  @override
  Future<bool> upload(File file, String relPath, {required int size, int? mtimeMs, bool send = false, void Function(int sent)? onProgress}) async {
    final req = await _http.putUrl(_u('/api/upload', {
      'path': relPath,
      'size': '$size',
      if (mtimeMs != null) 'mtime': '$mtimeMs',
      if (send) 'mode': 'send',
    }));
    _headers(req);
    req.contentLength = size;
    req.headers.contentType = ContentType.binary;
    var sent = 0;
    await req.addStream(file.openRead().map((chunk) {
      sent += chunk.length;
      onProgress?.call(sent);
      return chunk;
    }));
    final j = await _readJson(await req.close());
    return j['skipped'] != true;
  }

  @override
  void close() => _http.close(force: true);
}
