// Versi statis (GitHub Pages): pairing via QR + PeerJS, data lewat WebRTC DataChannel.
// Lawan bicara bisa browser HP (scan pakai kamera) atau aplikasi Android Sambung.
// Opsional: ?server=host:port untuk memakai server PeerJS sendiri (lihat README).
(() => {
  const $ = (id) => document.getElementById(id);
  const CHUNK = 16 * 1024;
  const PREFIX = 'sambung-hp-';
  const HOST_KEY = 'sambung-host-v1';

  // Hash QR: #<idLaptop>.<kunci>
  const [hashId, hashKey] = location.hash.slice(1).split('.');
  const isHost = !hashId;
  let conn = null;
  let peerName = 'HP';
  const incoming = new Map();
  let currentRx = null;
  let dirHandle = null; // folder simpan (File System Access API, Chrome/Edge)

  function randomId(n) {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    crypto.getRandomValues(new Uint8Array(n)).forEach((b) => (s += a[b % a.length]));
    return s;
  }

  // ID dan kunci laptop disimpan, supaya aplikasi HP bisa menyambung lagi tanpa scan ulang
  function hostIdentity(reset) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(HOST_KEY)); } catch {}
    if (!v || reset) {
      v = { id: PREFIX + randomId(10), key: randomId(16) };
      try { localStorage.setItem(HOST_KEY, JSON.stringify(v)); } catch {}
    }
    return v;
  }
  const me = isHost ? hostIdentity(false) : null;

  // ---------- UI ----------
  function setStatus(text, kind, modeText) {
    $('status').textContent = text;
    $('dot').className = 'dot' + (kind ? ' ' + kind : '');
    $('mode').textContent = modeText || '';
  }
  function addMsg(html, cls) {
    const d = document.createElement('div');
    d.className = 'msg ' + (cls || '');
    d.innerHTML = html;
    $('log').appendChild(d);
    $('log').scrollTop = $('log').scrollHeight;
    return d;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  function showWaiting() {
    $('chatCard').classList.add('hidden');
    if (isHost) $('pairCard').classList.remove('hidden');
    setStatus(isHost ? 'Menunggu HP scan QR…' : 'Menyambung ke laptop…', 'warn');
  }
  async function showConnected() {
    $('pairCard').classList.add('hidden');
    $('chatCard').classList.remove('hidden');
    const route = await routeType();
    const label = route === 'relay' ? 'lewat server TURN (relay)' : 'P2P langsung (WebRTC)';
    setStatus('Terhubung' + (isHost ? ' dengan ' + peerName : ''), 'ok', '· ' + label);
    addMsg('Terhubung ' + label, 'sys');
  }
  async function routeType() {
    try {
      const stats = await conn.peerConnection.getStats();
      let pair;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      if ((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay')) return 'relay';
    } catch { /* abaikan */ }
    return 'direct';
  }

  // ---------- Folder simpan (laptop) ----------
  const hasFS = 'showDirectoryPicker' in window;
  function idb(op, val) {
    return new Promise((resolve) => {
      try {
        const r = indexedDB.open('sambung', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
          const tx = r.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
          const st = tx.objectStore('kv');
          const q = op === 'get' ? st.get('dir') : st.put(val, 'dir');
          q.onsuccess = () => resolve(q.result);
          q.onerror = () => resolve(null);
        };
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  function showFolder() {
    if (!hasFS) {
      $('folderInfo').textContent = 'Browser ini tidak bisa menyimpan langsung ke folder. Pakai Chrome atau Edge di laptop untuk backup galeri; file kiriman akan muncul sebagai tautan unduh.';
      $('folderBtn').classList.add('hidden');
      return;
    }
    $('folderInfo').innerHTML = dirHandle
      ? `File dari HP tersimpan otomatis ke folder <b>${esc(dirHandle.name)}</b>.`
      : 'File dari HP akan langsung tersimpan ke folder ini. Wajib untuk backup galeri dari aplikasi.';
    $('folderBtn').textContent = dirHandle ? 'Ganti folder' : 'Pilih folder';
  }
  async function initFolder() {
    if (!isHost) { $('folderCard').classList.add('hidden'); return; }
    if (window.__sambungTestDir) { dirHandle = await window.__sambungTestDir; showFolder(); return; } // hanya untuk pengujian otomatis
    if (hasFS) {
      const h = await idb('get');
      if (h) {
        const p = await h.queryPermission({ mode: 'readwrite' });
        if (p === 'granted') dirHandle = h;
        else {
          $('folderAllowBtn').classList.remove('hidden');
          $('folderAllowBtn').onclick = async () => {
            if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') {
              dirHandle = h; $('folderAllowBtn').classList.add('hidden'); showFolder();
            }
          };
        }
      }
      $('folderBtn').onclick = async () => {
        try {
          dirHandle = await window.showDirectoryPicker({ id: 'sambung', mode: 'readwrite' });
          await idb('put', dirHandle);
          $('folderAllowBtn').classList.add('hidden');
          showFolder();
        } catch { /* dibatalkan */ }
      };
    }
    showFolder();
  }
  function cleanSeg(s) {
    return String(s).replace(/[<>:"|?*\\\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 150);
  }
  function relParts(p) {
    return String(p || '').split('/').map(cleanSeg).filter((x) => x && x !== '.' && x !== '..');
  }
  async function getDir(parts, create) {
    let d = dirHandle;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  async function fileSize(parts) {
    try {
      const d = await getDir(parts.slice(0, -1), false);
      const f = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
      return f.size;
    } catch { return -1; }
  }
  async function uniqueName(dir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; ; i++) {
      const n = i ? `${base} (${i})${ext}` : name;
      try { await dir.getFileHandle(n); } catch { return n; }
    }
  }
  // Lokasi simpan: <folder>/<nama HP>/<path di HP>  atau  <folder>/<nama HP>/Kiriman/<nama file>
  function targetParts(m) {
    const dev = cleanSeg(peerName) || 'HP';
    if (m.mode === 'backup' && m.path) return [dev, ...relParts(m.path)];
    return [dev, 'Kiriman', cleanSeg(m.name) || 'file'];
  }

  // ---------- PeerJS ----------
  function peerOptions() {
    const q = new URLSearchParams(location.search).get('server');
    if (!q) return { debug: 1 };
    const [host, port] = q.split(':');
    return { host, port: Number(port) || 443, path: '/', secure: location.protocol === 'https:', debug: 1 };
  }

  let peer;
  function startPeer() {
    peer = new Peer(isHost ? me.id : undefined, peerOptions());
    setStatus('Menyambung ke server pairing…');

    peer.on('open', (id) => {
      if (isHost) { renderQR(id); showWaiting(); }
      else {
        showWaiting();
        bindConn(peer.connect(hashId, { reliable: true, serialization: 'raw', metadata: { key: hashKey || '', name: 'Browser HP' } }));
      }
    });
    peer.on('connection', (c) => {
      if (!me || !c.metadata || c.metadata.key !== me.key) { c.on('open', () => c.close()); return; } // kunci salah
      if (conn && conn.open) { c.on('open', () => { c.send(JSON.stringify({ t: 'busy' })); setTimeout(() => c.close(), 500); }); return; }
      peerName = (c.metadata.name || 'HP').slice(0, 60);
      bindConn(c);
    });
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', (err) => {
      const map = {
        'peer-unavailable': 'Laptop tidak ditemukan. Pastikan halaman ini terbuka di laptop, lalu scan ulang QR-nya.',
        'unavailable-id': 'Halaman ini sudah terbuka di tab lain. Tutup tab lain itu lalu muat ulang.',
        network: 'Tidak bisa menghubungi server pairing. Pastikan ada internet.',
        'server-error': 'Server pairing sedang bermasalah. Coba lagi sebentar.',
        'browser-incompatible': 'Browser ini tidak mendukung WebRTC.',
      };
      setStatus(map[err.type] || 'Error: ' + err.message, 'warn');
    });
  }

  function bindConn(c) {
    conn = c;
    c.on('open', () => {
      const dc = c.dataChannel;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 1 << 20;
      if (isHost) send({ t: 'welcome', name: document.title });
      showConnected();
    });
    // Proses pesan berurutan: potongan file tidak boleh diproses sebelum file-meta selesai
    let rxChain = Promise.resolve();
    c.on('data', (d) => { rxChain = rxChain.then(() => onData(d)).catch((e) => addMsg('Error: ' + esc(e.message), 'sys')); });
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      for (const f of incoming.values()) { try { f.writer && f.writer.abort(); } catch {} }
      incoming.clear(); currentRx = null;
      if ($('log').childElementCount) addMsg('Perangkat lain terputus', 'sys');
      showWaiting();
      if (!isHost) setStatus('Terputus. Scan ulang QR di laptop untuk menyambung lagi.', 'warn');
    });
    c.on('error', (e) => setStatus('Koneksi gagal: ' + e.message, 'warn'));
  }

  // ---------- QR (laptop) ----------
  function renderQR(id) {
    const url = location.origin + location.pathname + location.search + '#' + id + '.' + me.key;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $('joinLink').textContent = url;
  }

  // ---------- Data ----------
  const send = (o) => conn && conn.open && conn.send(JSON.stringify(o));

  async function onData(d) {
    if (typeof d !== 'string') {
      const f = currentRx && incoming.get(currentRx);
      if (!f) return;
      f.got += d.byteLength;
      if (f.writer) f.chain = f.chain.then(() => f.writer.write(d));
      else f.parts.push(d);
      if (!f.quiet || f.got === f.meta.size) f.bar.value = f.got;
      return;
    }
    const m = JSON.parse(d);
    if (m.t === 'bye') { conn && conn.close(); return; }
    if (m.t === 'busy') { setStatus('Laptop sedang tersambung dengan perangkat lain.', 'warn'); return; }
    if (m.t === 'chat') { addMsg(esc(m.text)); return; }
    if (m.t === 'check') {
      // Aplikasi menanyakan file mana yang belum ada di folder laptop
      if (!dirHandle) { send({ t: 'need', id: m.id, canSave: false, need: [] }); return; }
      const need = [];
      for (let i = 0; i < m.files.length; i++) {
        const f = m.files[i];
        if ((await fileSize(targetParts({ mode: 'backup', path: f.path }))) !== f.size) need.push(i);
      }
      send({ t: 'need', id: m.id, canSave: true, need });
      return;
    }
    if (m.t === 'file-meta') {
      currentRx = m.id;
      const quiet = m.mode === 'backup';
      let el = null, bar = { value: 0 };
      if (!quiet || !incoming.lastBackupEl) {
        el = addMsg(`📄 <span class="fname">${esc(m.name)}</span> (${fmtSize(m.size)})<br><progress max="${m.size || 1}" value="0"></progress>`);
        bar = el.querySelector('progress');
        if (quiet) incoming.lastBackupEl = el;
      } else {
        el = incoming.lastBackupEl;
        el.querySelector('.fname').textContent = m.path || m.name;
        bar = el.querySelector('progress'); bar.max = m.size || 1;
      }
      const f = { meta: m, parts: [], got: 0, el, bar, quiet, chain: Promise.resolve(), writer: null };
      if (dirHandle) {
        try {
          const parts = targetParts(m);
          const dir = await getDir(parts.slice(0, -1), true);
          const name = m.mode === 'backup' ? parts[parts.length - 1] : await uniqueName(dir, parts[parts.length - 1]);
          const fh = await dir.getFileHandle(name, { create: true });
          f.writer = await fh.createWritable();
          f.savedAs = [...parts.slice(0, -1), name].join('/');
        } catch (e) {
          f.error = e.message;
        }
      }
      incoming.set(m.id, f);
      return;
    }
    if (m.t === 'file-end') {
      const f = incoming.get(m.id);
      if (!f) return;
      incoming.delete(m.id); currentRx = null;
      if (f.error) { send({ t: 'ack', id: m.id, saved: false, error: f.error }); return; }
      try {
        if (f.writer) {
          await f.chain;
          await f.writer.close();
          if (f.quiet) {
            incoming.backupCount = (incoming.backupCount || 0) + 1;
            f.el.querySelector('.fname').textContent = `Backup dari ${peerName}: ${incoming.backupCount} file tersimpan (terakhir: ${f.meta.path || f.meta.name})`;
          } else {
            f.el.innerHTML = `📄 ${esc(f.meta.name)} (${fmtSize(f.meta.size)}) ✓ tersimpan di <b>${esc(dirHandle.name)}/${esc(f.savedAs)}</b>`;
          }
        } else {
          const url = URL.createObjectURL(new Blob(f.parts, { type: f.meta.type || 'application/octet-stream' }));
          f.el.innerHTML = `📄 <a href="${url}" download="${esc(f.meta.name)}">${esc(f.meta.name)}</a> (${fmtSize(f.meta.size)})`;
        }
        send({ t: 'ack', id: m.id, saved: true });
      } catch (e) {
        send({ t: 'ack', id: m.id, saved: false, error: e.message });
      }
    }
  }

  function sendChat() {
    const text = $('text').value.trim();
    if (!text || !conn || !conn.open) return;
    send({ t: 'chat', text });
    addMsg(esc(text), 'me');
    $('text').value = '';
  }

  const waitDrain = () => new Promise((r) => {
    const dc = conn.dataChannel;
    if (dc.bufferedAmount < 4 << 20) return r();
    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
  });

  let sendQueue = Promise.resolve();
  function sendFile(file) {
    sendQueue = sendQueue.then(() => sendFileP2P(file)).catch((e) => addMsg('Gagal kirim: ' + esc(e.message), 'sys'));
  }
  async function sendFileP2P(file) {
    if (!conn || !conn.open) throw new Error('belum terhubung');
    const id = randomId(8);
    const el = addMsg(`📄 ${esc(file.name)} (${fmtSize(file.size)})<br><progress max="${file.size || 1}" value="0"></progress>`, 'me');
    const bar = el.querySelector('progress');
    send({ t: 'file-meta', id, name: file.name, size: file.size, type: file.type, mode: 'send' });
    for (let off = 0; off < file.size; off += CHUNK) {
      await waitDrain();
      conn.send(await file.slice(off, off + CHUNK).arrayBuffer());
      bar.value = Math.min(off + CHUNK, file.size);
    }
    send({ t: 'file-end', id });
    el.innerHTML = `📄 ${esc(file.name)} (${fmtSize(file.size)}) ✓ terkirim`;
  }

  $('sendBtn').onclick = sendChat;
  $('text').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  $('fileBtn').onclick = () => $('file').click();
  $('file').onchange = () => { [...$('file').files].forEach(sendFile); $('file').value = ''; };
  $('resetBtn').onclick = (e) => { e.preventDefault(); hostIdentity(true); location.reload(); };

  // Beri tahu pasangan saat tab ditutup, supaya laptop langsung kembali ke QR
  addEventListener('pagehide', () => { try { send({ t: 'bye' }); } catch {} });

  if (!isHost) $('pairCard').classList.add('hidden');
  initFolder();
  startPeer();
})();
