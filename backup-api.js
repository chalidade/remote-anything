// API untuk aplikasi Android "Sambung": pairing via QR, cek file, dan upload backup ke folder laptop.
// Semua endpoint (kecuali /api/pairinfo dan /api/recent yang hanya untuk laptop sendiri) butuh header X-Token.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const API_VERSION = 1;
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(os.homedir(), 'SambungBackup'));
const CONFIG = path.join(os.homedir(), '.sambung-hp.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* buat baru */ }
  const cfg = { token: crypto.randomBytes(18).toString('base64url'), name: os.hostname() };
  try { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch { /* tetap jalan */ }
  return cfg;
}
const cfg = loadConfig();
const recent = []; // riwayat file terakhir untuk halaman laptop

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function authed(req) {
  const t = Buffer.from(String(req.headers['x-token'] || ''));
  const want = Buffer.from(cfg.token);
  return t.length === want.length && crypto.timingSafeEqual(t, want);
}
// Bersihkan path relatif dari HP agar aman di Windows/macOS/Linux dan tidak bisa keluar folder backup
function cleanSegment(s) {
  return s.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 150);
}
function safeRel(p) {
  return String(p || '').split(/[\\/]+/).map(cleanSegment).filter((x) => x && x !== '.' && x !== '..');
}
function deviceDir(req) {
  const dev = cleanSegment(decodeURIComponent(String(req.headers['x-device'] || 'HP'))) || 'HP';
  return path.join(BACKUP_DIR, dev);
}
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
}
function readJson(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function pairUri(ctx) {
  const hosts = ctx.lanAddresses().map((a) => a.address).join(',');
  const q = new URLSearchParams({ hosts, port: String(ctx.port), token: cfg.token, name: cfg.name });
  return `sambung://pair?${q}`;
}

async function handle(req, res, url, ctx) {
  const p = url.pathname;

  // Hanya bisa diakses dari laptop itu sendiri (berisi token)
  if (p === '/api/pairinfo') {
    if (!isLoopback(req)) return json(res, 403, { error: 'Buka dari laptop ini (localhost).' });
    return json(res, 200, { name: cfg.name, backupDir: BACKUP_DIR, pairUri: pairUri(ctx), addresses: ctx.lanAddresses(), port: ctx.port });
  }
  if (p === '/api/recent') {
    if (!isLoopback(req)) return json(res, 403, {});
    return json(res, 200, { recent: recent.slice(-50).reverse() });
  }

  if (!authed(req)) return json(res, 401, { error: 'Token salah. Pairing ulang dari aplikasi.' });

  if (p === '/api/hello') {
    return json(res, 200, { app: 'sambung', apiVersion: API_VERSION, name: cfg.name });
  }

  // HP mengirim daftar file; server menjawab mana yang belum ada (berdasarkan path + ukuran)
  if (p === '/api/check' && req.method === 'POST') {
    const body = await readJson(req);
    const base = deviceDir(req);
    const need = [];
    (body.files || []).forEach((f, i) => {
      const rel = safeRel(f.path);
      if (!rel.length) return;
      try {
        const st = fs.statSync(path.join(base, ...rel));
        if (st.size !== Number(f.size)) need.push(i);
      } catch { need.push(i); }
    });
    return json(res, 200, { need });
  }

  // Upload satu file (body = isi file mentah, di-stream langsung ke disk)
  if (p === '/api/upload' && (req.method === 'PUT' || req.method === 'POST')) {
    const mode = url.searchParams.get('mode') === 'send' ? 'send' : 'backup';
    let rel = safeRel(url.searchParams.get('path'));
    if (!rel.length) return json(res, 400, { error: 'path kosong' });
    const size = Number(url.searchParams.get('size'));
    const mtime = Number(url.searchParams.get('mtime'));
    if (mode === 'send') rel = ['Kiriman', rel[rel.length - 1]];

    let dest = path.join(deviceDir(req), ...rel);
    if (mode === 'backup' && fs.existsSync(dest) && fs.statSync(dest).size === size) {
      req.resume();
      return json(res, 200, { skipped: true, path: path.relative(BACKUP_DIR, dest) });
    }
    if (fs.existsSync(dest)) dest = uniquePath(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part-' + crypto.randomBytes(4).toString('hex');
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const got = fs.statSync(tmp).size;
      if (Number.isFinite(size) && size >= 0 && got !== size) throw new Error(`ukuran tidak cocok (${got} != ${size})`);
      fs.renameSync(tmp, dest);
      if (mtime > 0) fs.utimesSync(dest, new Date(), new Date(mtime));
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      return json(res, 500, { error: String(e.message || e) });
    }
    const relOut = path.relative(BACKUP_DIR, dest);
    recent.push({ path: relOut, size, at: Date.now(), mode });
    if (recent.length > 500) recent.splice(0, recent.length - 500);
    return json(res, 200, { saved: true, path: relOut });
  }

  return json(res, 404, { error: 'not found' });
}

module.exports = { handle, BACKUP_DIR };
