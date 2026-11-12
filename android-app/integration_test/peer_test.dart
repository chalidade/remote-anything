import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sambung/pairing.dart';
import 'package:sambung/peer_link.dart';

// Uji koneksi aplikasi ↔ halaman web laptop. Butuh: server PeerJS lokal di :9000,
// halaman docs/ terbuka di browser (Playwright) dan menulis URL QR ke HOSTINFO.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('PeerLink ke halaman web: check + upload', (tester) async {
    final qr = File(Platform.environment['HOSTINFO'] ?? '/tmp/hostinfo.txt').readAsStringSync().trim();
    final info = PairInfo.fromQr(qr)!;
    expect(info.isWeb, true);

    final link = await PeerLink.connect(hostId: info.peerId, key: info.peerKey, deviceName: 'Tes HP', server: info.peerServer);
    expect(link.isOpen, true);

    final dir = Directory.systemTemp.createTempSync('sambung');
    final f = File('${dir.path}/video.mp4');
    final rnd = Random(1);
    f.writeAsBytesSync(List<int>.generate(3 * 1024 * 1024 + 123, (_) => rnd.nextInt(256)));
    final size = f.lengthSync();

    var r = await link.check([(path: 'DCIM/Camera/video.mp4', size: size), (path: 'DCIM/Camera/b.jpg', size: 5)]);
    expect(r.canSave, true);
    expect(r.need, {0, 1});

    var last = 0;
    final sw = Stopwatch()..start();
    final ok = await link.upload(f, 'DCIM/Camera/video.mp4', size: size, onProgress: (s) => last = s);
    // ignore: avoid_print
    print('upload ${size ~/ 1024} KB in ${sw.elapsedMilliseconds} ms');
    expect(ok, true);
    expect(last, size);

    r = await link.check([(path: 'DCIM/Camera/video.mp4', size: size)]);
    expect(r.need, isEmpty);

    final small = File('${dir.path}/catatan.txt')..writeAsStringSync('halo laptop');
    expect(await link.upload(small, 'catatan.txt', size: small.lengthSync(), send: true), true);

    // Kunci salah harus ditolak
    Object? err;
    try {
      final bad = await PeerLink.connect(hostId: info.peerId, key: 'salah', deviceName: 'X', server: info.peerServer, timeout: const Duration(seconds: 15));
      bad.close();
    } catch (e) {
      err = e;
    }
    expect(err, isNotNull);
    // ignore: avoid_print
    print('kunci salah ditolak: $err');
    link.close();
  }, timeout: const Timeout(Duration(minutes: 3)));
}
