import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:file_picker/file_picker.dart';
import 'package:material_ui/material_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'backup.dart';
import 'pairing.dart';
import 'peer_link.dart';
import 'scan_screen.dart';
import 'transport.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.info, required this.onUnpair});
  final PairInfo info;
  final VoidCallback onUnpair;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _backup = BackupService();
  late PairInfo _info = widget.info;
  String? _host; // alamat laptop yang sedang terjangkau (mode server)
  PeerLink? _link; // koneksi ke halaman web laptop (mode web)
  String? _connError;
  bool _checking = false;
  bool _includeVideos = true;
  String _device = 'HP';

  @override
  void initState() {
    super.initState();
    _backup.addListener(() => setState(() {}));
    _init();
  }

  Future<void> _init() async {
    final prefs = await SharedPreferences.getInstance();
    _includeVideos = prefs.getBool('include_videos') ?? true;
    var dev = prefs.getString('device_name');
    if (dev == null) {
      try {
        final a = await DeviceInfoPlugin().androidInfo;
        dev = '${a.manufacturer} ${a.model}'.trim();
      } catch (_) {
        dev = 'HP';
      }
      await prefs.setString('device_name', dev);
    }
    setState(() => _device = dev!);
    await _connect();
  }

  Future<void> _connect() async {
    setState(() {
      _checking = true;
      _connError = null;
    });
    if (_info.isWeb) return _connectWeb();
    try {
      final hello = await findLaptop(_info);
      _info.lastHost = hello.host;
      await _info.save();
      setState(() => _host = hello.host);
    } catch (e) {
      setState(() {
        _host = null;
        _connError = e.toString();
      });
    } finally {
      setState(() => _checking = false);
    }
  }

  Future<void> _connectWeb() async {
    _link?.close();
    _link = null;
    try {
      final link = await PeerLink.connect(hostId: _info.peerId, key: _info.peerKey, deviceName: _device, server: _info.peerServer);
      _link = link;
      setState(() => _host = 'lewat browser');
      link.closed.then((reason) {
        if (!mounted || _link != link) return;
        setState(() {
          _host = null;
          _connError = reason;
        });
      });
    } catch (e) {
      setState(() {
        _host = null;
        _connError = e.toString();
      });
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  void dispose() {
    _link?.close();
    super.dispose();
  }

  Transport _client() => _info.isWeb ? _link! : LaptopClient(host: _host!, port: _info.port, token: _info.token, device: _device);

  void _release(Transport c) {
    if (!_info.isWeb) c.close();
  }

  Future<void> _runBackup() async {
    final c = _client();
    await _backup.backupGallery(c, includeVideos: _includeVideos);
    _release(c);
  }

  Future<void> _sendFiles() async {
    final res = await FilePicker.pickFiles();
    final files = res.where((f) => f.path != null).map((f) => File(f.path!)).toList();
    if (files.isEmpty) return;
    final c = _client();
    await _backup.sendFiles(c, files);
    _release(c);
  }

  Future<void> _rePair() async {
    final info = await Navigator.of(context).push<PairInfo>(MaterialPageRoute(builder: (_) => const ScanScreen()));
    if (info != null) {
      _link?.close();
      _link = null;
      setState(() {
        _info = info;
        _host = null;
      });
      await _connect();
    }
  }

  Future<void> _renameDevice() async {
    final ctrl = TextEditingController(text: _device);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Nama HP ini'),
        content: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(helperText: 'Dipakai sebagai nama folder di laptop')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Batal')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Simpan')),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    (await SharedPreferences.getInstance()).setString('device_name', name);
    setState(() => _device = name);
  }

  @override
  Widget build(BuildContext context) {
    final s = _backup.state;
    final online = _host != null;
    final busy = s.running;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sambung'),
        actions: [
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'rename') _renameDevice();
              if (v == 'repair') _rePair();
              if (v == 'unpair') widget.onUnpair();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'rename', child: Text('Ganti nama HP')),
              PopupMenuItem(value: 'repair', child: Text('Pair ulang / ganti laptop')),
              PopupMenuItem(value: 'unpair', child: Text('Putuskan pairing')),
            ],
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _connect,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          Card(
            child: ListTile(
              leading: Icon(Icons.laptop, color: online ? Colors.green : Theme.of(context).colorScheme.outline),
              title: Text(_info.name),
              subtitle: Text(_checking
                  ? 'Menghubungi laptop…'
                  : online
                      ? 'Terhubung · $_host'
                      : (_connError ?? 'Tidak terjangkau')),
              trailing: IconButton(icon: const Icon(Icons.refresh), onPressed: _checking || busy ? null : _connect),
            ),
          ),
          const SizedBox(height: 8),
          SwitchListTile(
            title: const Text('Sertakan video'),
            subtitle: const Text('Video besar butuh waktu lebih lama'),
            value: _includeVideos,
            onChanged: busy
                ? null
                : (v) async {
                    setState(() => _includeVideos = v);
                    (await SharedPreferences.getInstance()).setBool('include_videos', v);
                  },
          ),
          const SizedBox(height: 8),
          FilledButton.icon(
            icon: const Icon(Icons.backup),
            label: const Padding(padding: EdgeInsets.all(12), child: Text('Backup galeri sekarang')),
            onPressed: online && !busy ? _runBackup : null,
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            icon: const Icon(Icons.upload_file),
            label: const Padding(padding: EdgeInsets.all(12), child: Text('Kirim file ke laptop')),
            onPressed: online && !busy ? _sendFiles : null,
          ),
          const SizedBox(height: 16),
          if (s.phase != JobPhase.idle) _JobCard(state: s, onCancel: _backup.cancel),
          const SizedBox(height: 16),
          Text(_info.isWeb ? 'Disimpan ke folder yang dipilih di halaman laptop, subfolder $_device' : 'Folder di laptop: SambungBackup/$_device', style: Theme.of(context).textTheme.bodySmall, textAlign: TextAlign.center),
          Text('Layar tetap menyala selama backup. Jangan tutup aplikasi.', style: Theme.of(context).textTheme.bodySmall, textAlign: TextAlign.center),
        ]),
      ),
    );
  }
}

String fmtBytes(int n) {
  if (n < 1024) return '$n B';
  if (n < 1048576) return '${(n / 1024).toStringAsFixed(0)} KB';
  if (n < 1073741824) return '${(n / 1048576).toStringAsFixed(1)} MB';
  return '${(n / 1073741824).toStringAsFixed(2)} GB';
}

class _JobCard extends StatelessWidget {
  const _JobCard({required this.state, required this.onCancel});
  final JobState state;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final s = state;
    final t = Theme.of(context).textTheme;
    String headline;
    switch (s.phase) {
      case JobPhase.scanning:
        headline = 'Memeriksa file…';
      case JobPhase.uploading:
        headline = 'Mengirim ${s.sentFiles + s.failed + 1 > s.toSend ? s.toSend : s.sentFiles + s.failed + 1} dari ${s.toSend}';
      case JobPhase.done:
        headline = 'Selesai';
      case JobPhase.failed:
        headline = 'Berhenti';
      case JobPhase.idle:
        headline = '';
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${s.title} · $headline', style: t.titleMedium),
          const SizedBox(height: 8),
          if (s.phase == JobPhase.scanning) const LinearProgressIndicator(),
          if (s.phase == JobPhase.uploading) LinearProgressIndicator(value: s.progress),
          if (s.current.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(s.current, maxLines: 1, overflow: TextOverflow.ellipsis)),
          if (s.phase == JobPhase.uploading) Text('${fmtBytes(s.sentBytes)} / ${fmtBytes(s.totalBytes)}', style: t.bodySmall),
          if (s.phase == JobPhase.done || s.phase == JobPhase.failed)
            Text('${s.sentFiles} terkirim · ${s.skipped} sudah ada · ${s.failed} gagal'),
          if (s.error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(s.error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          if (s.failures.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 8), child: Text(s.failures.take(3).join('\n'), style: t.bodySmall)),
          if (s.running) Align(alignment: Alignment.centerRight, child: TextButton(onPressed: onCancel, child: const Text('Batalkan'))),
        ]),
      ),
    );
  }
}
