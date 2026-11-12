import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'transport.dart';

/// Koneksi ke halaman Sambung di browser laptop (GitHub Pages) lewat server signaling PeerJS
/// dan WebRTC DataChannel. Mengikuti protokol PeerJS 1.5 supaya kompatibel dengan peerjs.min.js.
class PeerLink implements Transport {
  PeerLink._(this.hostId, this.key, this.deviceName, this.server);

  final String hostId;
  final String key;
  final String deviceName;
  final PeerServer server;

  late final String _myId = 'sambung-app-${_rand(12)}';
  late final String _connId = 'dc_${_rand(12)}';
  WebSocketChannel? _ws;
  Timer? _heartbeat;
  RTCPeerConnection? _pc;
  RTCDataChannel? _dc;
  bool _remoteSet = false;
  final List<RTCIceCandidate> _pendingCandidates = [];
  final Map<String, Completer<Map<String, dynamic>>> _waiting = {};
  final _closed = Completer<String>();
  bool _isClosed = false;
  bool _dcOpen = false;

  /// Selesai (dengan alasan) saat koneksi putus.
  Future<String> get closed => _closed.future;
  bool get isOpen => !_isClosed && _dcOpen;

  static String _rand(int n) {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    final r = Random.secure();
    return List.generate(n, (_) => a[r.nextInt(a.length)]).join();
  }

  static const _iceServers = [
    {'urls': 'stun:stun.l.google.com:19302'},
    {
      'urls': ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
      'username': 'peerjs',
      'credential': 'peerjsp',
    },
  ];

  /// Membuka koneksi. Gagal dengan pesan yang bisa ditampilkan ke pengguna.
  static Future<PeerLink> connect({
    required String hostId,
    required String key,
    required String deviceName,
    PeerServer server = PeerServer.cloud,
    Duration timeout = const Duration(seconds: 25),
  }) async {
    final link = PeerLink._(hostId, key, deviceName, server);
    try {
      await link._open().timeout(
        timeout,
        onTimeout: () => throw 'Waktu habis saat menyambung ke laptop. Pastikan halaman Sambung terbuka di laptop.',
      );
      return link;
    } catch (e) {
      link.close();
      rethrow;
    }
  }

  Future<void> _open() async {
    final opened = Completer<void>();
    final uri = Uri.parse(
      '${server.secure ? 'wss' : 'ws'}://${server.host}:${server.port}${server.path}peerjs'
      '?key=${server.key}&id=$_myId&token=${_rand(10)}&version=1.5.4',
    );
    final ws = WebSocketChannel.connect(uri);
    _ws = ws;
    await ws.ready.catchError((_) => throw 'Tidak bisa menghubungi server pairing. Pastikan HP terhubung ke internet.');

    ws.stream.listen(
      (raw) async {
        if (_isClosed) return;
        try {
          await _onSignal(raw, opened);
        } catch (_) {
          // Pesan signaling yang datang setelah koneksi ditutup diabaikan
        }
      },
      onDone: () {
        // Socket signaling putus. Kalau DataChannel sudah jalan, transfer tetap bisa lanjut.
        if (!opened.isCompleted) opened.completeError('Koneksi ke server pairing terputus.');
      },
      onError: (_) {},
    );

    _openedCompleter = opened;
    await opened.future;
  }

  Future<void> _onSignal(dynamic raw, Completer<void> opened) async {
    Map<String, dynamic> m;
    try {
      m = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final payload = m['payload'];
    switch (m['type']) {
      case 'OPEN':
        _startHeartbeat();
        try {
          await _makeOffer();
        } catch (e) {
          if (!opened.isCompleted) opened.completeError('Gagal membuat koneksi: $e');
        }
      case 'ID-TAKEN':
      case 'INVALID-KEY':
      case 'ERROR':
        if (!opened.isCompleted) opened.completeError('Server pairing menolak: ${payload is Map ? payload['msg'] : m['type']}');
      case 'EXPIRE':
        if (!opened.isCompleted) opened.completeError('Laptop tidak ditemukan. Buka halaman Sambung di laptop, lalu coba lagi.');
      case 'ANSWER':
        if (payload is Map && payload['connectionId'] == _connId) {
          final sdp = payload['sdp'] as Map;
          await _pc?.setRemoteDescription(RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?));
          _remoteSet = true;
          for (final c in _pendingCandidates) {
            await _pc?.addCandidate(c);
          }
          _pendingCandidates.clear();
        }
      case 'CANDIDATE':
        if (payload is Map && payload['connectionId'] == _connId) {
          final c = payload['candidate'] as Map;
          final cand = RTCIceCandidate(c['candidate'] as String?, c['sdpMid'] as String?, (c['sdpMLineIndex'] as num?)?.toInt());
          if (_remoteSet) {
            await _pc?.addCandidate(cand);
          } else {
            _pendingCandidates.add(cand);
          }
        }
      case 'LEAVE':
        if (m['src'] == hostId) _shutdown('Laptop menutup halaman Sambung.');
    }
  }

  Completer<void>? _openedCompleter;

  void _startHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(seconds: 5), (_) => _wsSend({'type': 'HEARTBEAT'}));
  }

  void _wsSend(Map<String, dynamic> m) {
    try {
      _ws?.sink.add(jsonEncode(m));
    } catch (_) {}
  }

  Future<void> _makeOffer() async {
    final pc = await createPeerConnection({'iceServers': _iceServers, 'sdpSemantics': 'unified-plan'});
    _pc = pc;
    pc.onIceCandidate = (c) {
      if (c.candidate == null || c.candidate!.isEmpty) return;
      _wsSend({
        'type': 'CANDIDATE',
        'payload': {
          'candidate': {'candidate': c.candidate, 'sdpMid': c.sdpMid, 'sdpMLineIndex': c.sdpMLineIndex},
          'type': 'data',
          'connectionId': _connId,
        },
        'dst': hostId,
      });
    };
    pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        final o = _openedCompleter;
        if (o != null && !o.isCompleted) o.completeError('Koneksi langsung ke laptop gagal. Coba jaringan lain.');
        _shutdown('Koneksi ke laptop gagal.');
      }
    };

    final dc = await pc.createDataChannel(_connId, RTCDataChannelInit()..ordered = true);
    _dc = dc;
    dc.bufferedAmountLowThreshold = 1 << 20;
    dc.onDataChannelState = (st) {
      if (st == RTCDataChannelState.RTCDataChannelOpen) {
        _dcOpen = true;
        // Tunggu pesan 'welcome' dari laptop (tanda kunci diterima)
      } else if (st == RTCDataChannelState.RTCDataChannelClosed && _dcOpen) {
        final o = _openedCompleter;
        if (o != null && !o.isCompleted) o.completeError('Laptop menolak koneksi. QR mungkin sudah diganti; scan ulang.');
        _shutdown('Koneksi ke laptop terputus.');
      }
    };
    dc.onMessage = (msg) {
      if (msg.isBinary) return;
      Map<String, dynamic> m;
      try {
        m = jsonDecode(msg.text) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      final t = m['t'];
      if (t == 'welcome') {
        final o = _openedCompleter;
        if (o != null && !o.isCompleted) o.complete();
      } else if (t == 'need' || t == 'ack') {
        _waiting.remove('$t:${m['id']}')?.complete(m);
      } else if (t == 'busy') {
        final o = _openedCompleter;
        if (o != null && !o.isCompleted) o.completeError('Laptop sedang tersambung dengan perangkat lain.');
      } else if (t == 'bye') {
        _shutdown('Laptop menutup halaman Sambung.');
      }
    };

    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _wsSend({
      'type': 'OFFER',
      'payload': {
        'sdp': {'type': offer.type, 'sdp': offer.sdp},
        'type': 'data',
        'connectionId': _connId,
        'label': _connId,
        'reliable': true,
        'serialization': 'raw',
        'metadata': {'key': key, 'name': deviceName, 'app': 'sambung-android'},
        'browser': 'sambung-flutter',
      },
      'dst': hostId,
    });
  }

  void _shutdown(String reason) {
    if (_isClosed) return;
    _isClosed = true;
    for (final c in _waiting.values) {
      if (!c.isCompleted) c.completeError(reason);
    }
    _waiting.clear();
    if (!_closed.isCompleted) _closed.complete(reason);
    _heartbeat?.cancel();
    _dc?.close().catchError((_) {});
    _pc?.close().catchError((_) {});
    try {
      _ws?.sink.close();
    } catch (_) {}
  }

  Future<void> _sendJson(Map<String, dynamic> m) async {
    if (!isOpen) throw 'Koneksi ke laptop terputus.';
    await _dc!.send(RTCDataChannelMessage(jsonEncode(m)));
  }

  Future<Map<String, dynamic>> _request(String kind, String id, Map<String, dynamic> msg, Duration timeout) {
    final c = Completer<Map<String, dynamic>>();
    _waiting['$kind:$id'] = c;
    _sendJson(msg).catchError((Object e) {
      if (!c.isCompleted) c.completeError(e);
    });
    return c.future.timeout(
      timeout,
      onTimeout: () {
        _waiting.remove('$kind:$id');
        throw 'Laptop tidak menjawab.';
      },
    );
  }

  @override
  Future<CheckResult> check(List<({String path, int size})> files) async {
    final id = _rand(8);
    final r = await _request('need', id, {
      't': 'check',
      'id': id,
      'files': [
        for (final f in files) {'path': f.path, 'size': f.size},
      ],
    }, const Duration(seconds: 60));
    return CheckResult((r['need'] as List).cast<num>().map((e) => e.toInt()).toSet(), canSave: r['canSave'] == true);
  }

  Future<void> _drain() async {
    final dc = _dc!;
    while ((dc.bufferedAmount ?? 0) > (4 << 20)) {
      await Future<void>.delayed(const Duration(milliseconds: 15));
      await dc.getBufferedAmount();
      if (!isOpen) throw 'Koneksi ke laptop terputus.';
    }
  }

  @override
  Future<bool> upload(
    File file,
    String relPath, {
    required int size,
    int? mtimeMs,
    bool send = false,
    void Function(int sent)? onProgress,
  }) async {
    final id = _rand(8);
    final name = relPath.split('/').last;
    await _sendJson({
      't': 'file-meta',
      'id': id,
      'name': name,
      'size': size,
      'path': relPath,
      'mode': send ? 'send' : 'backup',
      if (mtimeMs != null) 'mtime': mtimeMs,
    });
    // Daftarkan penantian ack sebelum mengirim isi, supaya ack tidak terlewat
    final ack = Completer<Map<String, dynamic>>();
    _waiting['ack:$id'] = ack;
    var sent = 0;
    await for (final chunk in file.openRead()) {
      if (!isOpen) throw 'Koneksi ke laptop terputus.';
      await _drain();
      await _dc!.send(RTCDataChannelMessage.fromBinary(chunk is Uint8List ? chunk : Uint8List.fromList(chunk)));
      sent += chunk.length;
      onProgress?.call(sent);
    }
    await _sendJson({'t': 'file-end', 'id': id});
    final r = await ack.future.timeout(
      const Duration(minutes: 2),
      onTimeout: () {
        _waiting.remove('ack:$id');
        throw 'Laptop tidak mengonfirmasi file.';
      },
    );
    if (r['saved'] != true) throw r['error']?.toString() ?? 'Laptop gagal menyimpan file.';
    return true;
  }

  @override
  void close() {
    try {
      if (isOpen) _dc!.send(RTCDataChannelMessage(jsonEncode({'t': 'bye'})));
    } catch (_) {}
    _shutdown('Ditutup.');
  }
}

/// Alamat server signaling PeerJS.
class PeerServer {
  const PeerServer({required this.host, required this.port, required this.secure, this.path = '/', this.key = 'peerjs'});
  final String host;
  final int port;
  final bool secure;
  final String path;
  final String key;

  static const cloud = PeerServer(host: '0.peerjs.com', port: 443, secure: true);

  Map<String, dynamic> toJson() => {'host': host, 'port': port, 'secure': secure, 'path': path, 'key': key};
  static PeerServer fromJson(Map<String, dynamic> j) => PeerServer(
    host: j['host'] as String,
    port: j['port'] as int,
    secure: j['secure'] as bool,
    path: j['path'] as String? ?? '/',
    key: j['key'] as String? ?? 'peerjs',
  );
}
