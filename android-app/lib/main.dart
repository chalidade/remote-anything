import 'package:material_ui/material_ui.dart';

import 'home_screen.dart';
import 'pairing.dart';
import 'scan_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SambungApp());
}

class SambungApp extends StatelessWidget {
  const SambungApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF1F6FEB);
    return MaterialApp(
      title: 'Sambung',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed)),
      darkTheme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark)),
      home: const RootPage(),
    );
  }
}

/// Menentukan halaman awal: pairing (jika belum) atau beranda.
class RootPage extends StatefulWidget {
  const RootPage({super.key});

  @override
  State<RootPage> createState() => _RootPageState();
}

class _RootPageState extends State<RootPage> {
  PairInfo? _info;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    PairInfo.load().then((i) => setState(() {
          _info = i;
          _loading = false;
        }));
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final info = _info;
    if (info == null) return WelcomePage(onPaired: (i) => setState(() => _info = i));
    return HomeScreen(
      info: info,
      onUnpair: () async {
        await PairInfo.clear();
        setState(() => _info = null);
      },
    );
  }
}

class WelcomePage extends StatelessWidget {
  const WelcomePage({super.key, required this.onPaired});
  final void Function(PairInfo) onPaired;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Icon(Icons.devices, size: 72, color: Theme.of(context).colorScheme.primary),
              const SizedBox(height: 16),
              Text('Sambung', style: t.headlineMedium, textAlign: TextAlign.center),
              const SizedBox(height: 8),
              Text('Backup foto & video dari HP ke laptop sendiri, tanpa cloud dan tanpa kuota.',
                  style: t.bodyLarge, textAlign: TextAlign.center),
              const Spacer(),
              const _Step(n: 1, text: 'Di laptop, jalankan server Sambung (node server.js).'),
              const _Step(n: 2, text: 'Buka http://localhost:8080/backup.html di laptop.'),
              const _Step(n: 3, text: 'Pastikan HP dan laptop di Wi-Fi yang sama, lalu scan QR-nya.'),
              const SizedBox(height: 24),
              FilledButton.icon(
                icon: const Icon(Icons.qr_code_scanner),
                label: const Padding(padding: EdgeInsets.all(12), child: Text('Pair dengan laptop')),
                onPressed: () async {
                  final info = await Navigator.of(context).push<PairInfo>(MaterialPageRoute(builder: (_) => const ScanScreen()));
                  if (info != null) onPaired(info);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.n, required this.text});
  final int n;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          CircleAvatar(radius: 12, child: Text('$n', style: const TextStyle(fontSize: 12))),
          const SizedBox(width: 12),
          Expanded(child: Text(text)),
        ]),
      );
}
