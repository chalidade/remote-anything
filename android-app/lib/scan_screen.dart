import 'package:material_ui/material_ui.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'pairing.dart';

/// Scan QR dari halaman backup.html di laptop, lalu verifikasi koneksi.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  bool _busy = false;
  String? _message;

  Future<void> _onDetect(BarcodeCapture cap) async {
    if (_busy) return;
    final raw = cap.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
    if (raw == null) return;
    final info = PairInfo.fromQr(raw);
    if (info == null) {
      setState(() => _message = 'Ini bukan QR Sambung. Buka /backup.html di laptop.');
      return;
    }
    setState(() {
      _busy = true;
      _message = 'Menghubungi ${info.name}…';
    });
    try {
      final hello = await findLaptop(info);
      info.lastHost = hello.host;
      await info.save();
      if (mounted) Navigator.of(context).pop(info);
    } catch (e) {
      setState(() {
        _busy = false;
        _message = e.toString();
      });
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan QR di laptop')),
      body: Column(children: [
        Expanded(child: MobileScanner(controller: _controller, onDetect: _onDetect)),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            if (_busy) const Padding(padding: EdgeInsets.only(right: 12), child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
            Expanded(child: Text(_message ?? 'Arahkan kamera ke QR di halaman backup laptop.')),
          ]),
        ),
      ]),
    );
  }
}
