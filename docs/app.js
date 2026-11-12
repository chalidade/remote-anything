// Versi statis (GitHub Pages): pairing via QR + PeerJS, data lewat WebRTC DataChannel.
// Tidak butuh server sendiri. Server signaling PeerJS hanya dipakai saat pairing.
// Opsional: ?server=host:port untuk memakai server PeerJS sendiri (lihat README).
(() => {
  const $ = (id) => document.getElementById(id);
  const CHUNK = 16 * 1024;
  const PREFIX = 'sambung-hp-';

  const hostId = location.hash.slice(1);
  const isHost = !hostId;
  let conn = null;
  const incoming = new Map();
  let currentRx = null;

  function randomId(n) {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    crypto.getRandomValues(new Uint8Array(n)).forEach((b) => (s += a[b % a.length]));
    return s;
  }

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
    setStatus('Terhubung', 'ok', '· ' + label);
    addMsg('Terhubung ' + label, 'sys');
  }
  // Cek apakah jalur yang dipakai langsung atau lewat TURN
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

  // ---------- PeerJS ----------
  function peerOptions() {
    const q = new URLSearchParams(location.search).get('server');
    if (!q) return { debug: 1 };
    const [host, port] = q.split(':');
    return { host, port: Number(port) || 443, path: '/', secure: location.protocol === 'https:', debug: 1 };
  }

  const peer = new Peer(isHost ? PREFIX + randomId(8) : undefined, peerOptions());
  setStatus('Menyambung ke server pairing…');

  peer.on('open', (id) => {
    if (isHost) { renderQR(id); showWaiting(); }
    else {
      showWaiting();
      bindConn(peer.connect(hostId, { reliable: true, serialization: 'raw' }));
    }
  });
  peer.on('connection', (c) => {
    if (conn && conn.open) { c.on('open', () => c.close()); return; } // hanya 1 pasangan
    bindConn(c);
  });
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', (err) => {
    const map = {
      'peer-unavailable': 'Laptop tidak ditemukan. Muat ulang halaman di laptop lalu scan QR yang baru.',
      network: 'Tidak bisa menghubungi server pairing. Pastikan ada internet.',
      'server-error': 'Server pairing sedang bermasalah. Coba lagi sebentar.',
      'browser-incompatible': 'Browser ini tidak mendukung WebRTC.',
    };
    setStatus(map[err.type] || 'Error: ' + err.message, 'warn');
  });

  function bindConn(c) {
    conn = c;
    c.on('open', () => {
      const dc = c.dataChannel;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 1 << 20;
      showConnected();
    });
    c.on('data', onData);
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      if ($('log').childElementCount) addMsg('Perangkat lain terputus', 'sys');
      showWaiting();
      if (!isHost) setStatus('Terputus. Scan ulang QR di laptop untuk menyambung lagi.', 'warn');
    });
    c.on('error', (e) => setStatus('Koneksi gagal: ' + e.message, 'warn'));
  }

  // ---------- QR (laptop) ----------
  function renderQR(id) {
    const url = location.origin + location.pathname + location.search + '#' + id;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $('joinLink').textContent = url;
  }

  // ---------- Data ----------
  function onData(d) {
    if (typeof d !== 'string') {
      const f = currentRx && incoming.get(currentRx);
      if (!f) return;
      f.parts.push(d); f.got += d.byteLength;
      f.bar.value = f.got;
      return;
    }
    const m = JSON.parse(d);
    if (m.t === 'bye') { conn && conn.close(); return; }
    if (m.t === 'chat') addMsg(esc(m.text));
    else if (m.t === 'file-meta') {
      currentRx = m.id;
      const el = addMsg(`📄 ${esc(m.name)} (${fmtSize(m.size)})<br><progress max="${m.size || 1}" value="0"></progress>`);
      incoming.set(m.id, { meta: m, parts: [], got: 0, el, bar: el.querySelector('progress') });
    } else if (m.t === 'file-end') {
      const f = incoming.get(m.id);
      if (!f) return;
      const url = URL.createObjectURL(new Blob(f.parts, { type: f.meta.type || 'application/octet-stream' }));
      f.el.innerHTML = `📄 <a href="${url}" download="${esc(f.meta.name)}">${esc(f.meta.name)}</a> (${fmtSize(f.meta.size)})`;
      incoming.delete(m.id); currentRx = null;
    }
  }

  function sendChat() {
    const text = $('text').value.trim();
    if (!text || !conn || !conn.open) return;
    conn.send(JSON.stringify({ t: 'chat', text }));
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
    conn.send(JSON.stringify({ t: 'file-meta', id, name: file.name, size: file.size, type: file.type }));
    for (let off = 0; off < file.size; off += CHUNK) {
      await waitDrain();
      conn.send(await file.slice(off, off + CHUNK).arrayBuffer());
      bar.value = Math.min(off + CHUNK, file.size);
    }
    conn.send(JSON.stringify({ t: 'file-end', id }));
    el.innerHTML = `📄 ${esc(file.name)} (${fmtSize(file.size)}) ✓ terkirim`;
  }

  $('sendBtn').onclick = sendChat;
  $('text').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  $('fileBtn').onclick = () => $('file').click();
  $('file').onchange = () => { [...$('file').files].forEach(sendFile); $('file').value = ''; };

  // Beri tahu pasangan saat tab ditutup, supaya laptop langsung kembali ke QR
  addEventListener('pagehide', () => { try { conn && conn.open && conn.send(JSON.stringify({ t: 'bye' })); } catch {} });

  if (!isHost) $('pairCard').classList.add('hidden');
})();
