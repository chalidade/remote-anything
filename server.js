// Server kecil untuk pairing HP <-> laptop.
// - Menyajikan web app dari folder public/
// - Signaling WebRTC lewat Server-Sent Events (tanpa dependency npm)
// - Relay cadangan (chat + file) jika koneksi P2P WebRTC gagal
// Jalankan: node server.js   (opsional: PORT=9000 node server.js)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const backup = require('./backup-api');
const PUBLIC = path.join(__dirname, 'public');
const MAX_FILE = 500 * 1024 * 1024; // 500 MB untuk mode relay

const rooms = new Map(); // roomId -> Map(peerId -> res)
const files = new Map(); // fileId -> { name, type, buf, room, at }

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function send(res, ev) {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

function broadcast(room, from, ev, to) {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const [id, res] of peers) {
    if (id === from) continue;
    if (to && id !== to) continue;
    send(res, ev);
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await backup.handle(req, res, url, { port: PORT, lanAddresses });

    if (url.pathname === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ port: PORT, addresses: lanAddresses() }));
    }

    if (url.pathname === '/events') {
      const room = url.searchParams.get('room');
      const id = url.searchParams.get('id');
      if (!room || !id) { res.writeHead(400); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': ok\n\n');
      if (!rooms.has(room)) rooms.set(room, new Map());
      const peers = rooms.get(room);
      const others = [...peers.keys()];
      peers.set(id, res);
      send(res, { type: 'welcome', peers: others });
      broadcast(room, id, { type: 'peer-joined', from: id });
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        peers.delete(id);
        broadcast(room, id, { type: 'peer-left', from: id });
        if (peers.size === 0) rooms.delete(room);
      });
      return;
    }

    if (url.pathname === '/signal' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString());
      broadcast(body.room, body.from, { type: 'signal', from: body.from, data: body.data }, body.to);
      res.writeHead(204); return res.end();
    }

    // Relay cadangan: upload file ke server, peer lain diberi tautan unduh
    if (url.pathname === '/upload' && req.method === 'POST') {
      const room = url.searchParams.get('room');
      const from = url.searchParams.get('from');
      const name = url.searchParams.get('name') || 'file';
      const buf = await readBody(req, MAX_FILE);
      const fid = crypto.randomBytes(8).toString('hex');
      files.set(fid, { name, type: req.headers['content-type'] || 'application/octet-stream', buf, at: Date.now() });
      broadcast(room, from, { type: 'relay-file', from, id: fid, name, size: buf.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: fid }));
    }

    if (url.pathname.startsWith('/file/')) {
      const f = files.get(url.pathname.slice(6));
      if (!f) { res.writeHead(404); return res.end('File tidak ditemukan'); }
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.buf.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      return res.end(f.buf);
    }

    // File statis
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const fp = path.normalize(path.join(PUBLIC, p));
    if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    res.writeHead(500); res.end(String(e.message || e));
  }
});

// Hapus file relay yang lebih dari 1 jam
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, f] of files) if (f.at < cutoff) files.delete(k);
}, 600_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nWeb app berjalan.`);
  console.log(`  Di laptop buka : http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  Alamat LAN (${a.name}) : http://${a.address}:${PORT}`);
  console.log(`\nBackup dari aplikasi Android:`);
  console.log(`  Buka http://localhost:${PORT}/backup.html lalu scan QR-nya dari aplikasi.`);
  console.log(`  File disimpan di: ${backup.BACKUP_DIR}`);
  console.log(`\nPastikan HP dan laptop di Wi-Fi/hotspot yang sama, lalu scan QR di layar laptop.\n`);
});
