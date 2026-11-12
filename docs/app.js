// Versi statis (GitHub Pages): pairing via QR + PeerJS, data lewat WebRTC DataChannel.
// Laptop (host) bisa melayani banyak HP sekaligus: browser HP (scan pakai kamera) atau aplikasi Android Sambung.
// Opsional: ?server=host:port untuk memakai server PeerJS sendiri (lihat README).
(() => {
  const $ = (id) => document.getElementById(id);
  const CHUNK = 16 * 1024;
  const PREFIX = 'sambung-hp-';
  const HOST_KEY = 'sambung-host-v1';
  const GUEST_KEY = 'sambung-guest-v1';

  // Hash QR: #<idLaptop>.<kunci>
  const [hashId, hashKey] = location.hash.slice(1).split('.');
  const isHost = !hashId;
  let dirHandle = null; // folder simpan (File System Access API, Chrome/Edge)

  function randomId(n) {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    crypto.getRandomValues(new Uint8Array(n)).forEach((b) => (s += a[b % a.length]));
    return s;
  }
  function stored(key, make, reset) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(key)); } catch {}
    if (!v || reset) {
      v = make();
      try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
    }
    return v;
  }
  // ID dan kunci laptop disimpan, supaya HP bisa menyambung lagi tanpa scan ulang
  const hostIdentity = (reset) => stored(HOST_KEY, () => ({ id: PREFIX + randomId(10), key: randomId(16) }), reset);
  const me = isHost ? hostIdentity(false) : null;
  // Browser HP juga punya ID tetap, supaya laptop mengenalinya sebagai perangkat yang sama
  const guest = isHost ? null : stored(GUEST_KEY, () => ({ devId: 'web-' + randomId(8), name: 'HP ' + randomId(3).toUpperCase() }));

  // ---------- Util ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const hhmm = (d = new Date()) => d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const TICKS = '<svg class="ticks" viewBox="0 0 16 11" aria-hidden="true"><path d="M11.1.6 4.8 6.9 2 4.1.9 5.2l3.9 3.9L12.2 1.7z"/><path d="m14.9.6-6.3 6.3-.8-.8-1.1 1.1 1.9 1.9 7.4-7.4z"/></svg>';
  const setBody = (el, html) => { (el.querySelector('.body') || el).innerHTML = html; };
  const initial = (name) => (String(name).trim().charAt(0) || 'H').toUpperCase();
  const AV_COLORS = ['#6b7c85', '#00a884', '#7f66ff', '#e26a3a', '#2a9fd6', '#c4458f', '#a78b00'];
  const avColor = (s) => AV_COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV_COLORS.length];

  function setStatus(text, kind, modeText) {
    $('status').textContent = text;
    $('dot').className = 'dot' + (kind ? ' ' + kind : '');
    $('mode').textContent = modeText || '';
  }

  // ---------- Perangkat ----------
  // Setiap perangkat punya koneksi, riwayat chat, dan antrean transfer sendiri.
  const devices = new Map();
  let selected = null; // id perangkat yang percakapannya sedang dibuka

  function getDevice(id, name) {
    let d = devices.get(id);
    if (!d) {
      const log = document.createElement('div');
      log.className = 'thread hidden';
      $('log').appendChild(log);
      d = { id, name, conn: null, online: false, route: '', log, incoming: new Map(), currentRx: null,
            sendQueue: Promise.resolve(), backupEl: null, backupCount: 0, last: '', lastAt: null, unread: 0 };
      devices.set(id, d);
    }
    if (name) d.name = name;
    return d;
  }

  function addMsg(d, html, cls) {
    const el = document.createElement('div');
    el.className = 'msg ' + (cls || '');
    if (cls === 'sys') el.innerHTML = html;
    else el.innerHTML = `<div class="body">${html}</div><span class="meta">${hhmm()}${cls === 'me' ? TICKS : ''}</span>`;
    d.log.appendChild(el);
    if (cls !== 'sys') {
      d.last = (cls === 'me' ? 'Kamu: ' : '') + (el.querySelector('.body').textContent || '').trim();
      d.lastAt = new Date();
      if (cls !== 'me' && selected !== d.id) d.unread++;
    }
    if (selected === d.id) $('log').scrollTop = $('log').scrollHeight;
    renderList();
    return el;
  }

  function renderList() {
    if (!isHost) return;
    const list = [...devices.values()].sort((a, b) => (b.online - a.online) || ((b.lastAt || 0) - (a.lastAt || 0)));
    $('devList').innerHTML = list.map((d) => `
      <div class="dev${d.id === selected ? ' active' : ''}" data-id="${esc(d.id)}" role="button" tabindex="0">
        <div class="avatar" style="background:${avColor(d.name)}">${esc(initial(d.name))}${d.online ? '<span class="online"></span>' : ''}</div>
        <div class="text">
          <div class="row1"><span class="name">${esc(d.name)}</span><span class="when">${d.lastAt ? hhmm(d.lastAt) : ''}</span></div>
          <div class="row2"><span class="last">${esc(d.last || (d.online ? 'Tersambung' : 'Offline'))}</span>${d.unread ? `<span class="badge">${d.unread}</span>` : ''}</div>
        </div>
      </div>`).join('');
    $('devEmpty').classList.toggle('hidden', devices.size > 0);
    const n = list.filter((d) => d.online).length;
    if (n) setStatus(`${n} perangkat tersambung`, 'ok');
    else setStatus('Menunggu HP scan QR…', 'warn');
    $('newDev').classList.toggle('active', !selected);
  }

  function select(id) {
    selected = id;
    for (const d of devices.values()) d.log.classList.toggle('hidden', d.id !== id);
    const d = id && devices.get(id);
    $('pairCard').classList.toggle('hidden', !!d);
    $('chatCard').classList.toggle('hidden', !d);
    if (d) {
      d.unread = 0;
      $('chatName').textContent = d.name;
      $('chatAvatar').textContent = initial(d.name);
      $('chatAvatar').style.background = avColor(d.name);
      $('chatSub').textContent = d.online ? 'online · ' + d.route : 'offline';
      $('text').disabled = !d.online;
      $('text').placeholder = d.online ? 'Ketik pesan' : 'Perangkat sedang offline';
      $('log').scrollTop = $('log').scrollHeight;
      document.body.classList.add('in-chat');
    } else {
      document.body.classList.remove('in-chat');
    }
    renderList();
  }

  async function routeType(conn) {
    try {
      const stats = await conn.peerConnection.getStats();
      let pair;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      if ((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay')) return 'lewat server TURN (relay)';
    } catch { /* abaikan */ }
    return 'P2P langsung (WebRTC)';
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
      ? `Tersimpan otomatis ke folder <b>${esc(dirHandle.name || 'pilihan')}</b>, subfolder per HP.`
      : 'File dari HP akan langsung tersimpan ke folder ini. Wajib untuk backup galeri dari aplikasi.';
    $('folderBtnLabel').textContent = dirHandle ? 'Ganti folder' : 'Pilih folder';
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
  function targetParts(d, m) {
    const dev = cleanSeg(d.name) || 'HP';
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
    setStatus('Menyambung ke server pairing…', 'warn');

    peer.on('open', (id) => {
      if (isHost) { renderQR(id); renderList(); }
      else {
        setStatus('Menyambung ke laptop…', 'warn');
        const d = getDevice('laptop', 'Laptop');
        bind(d, peer.connect(hashId, { reliable: true, serialization: 'raw', metadata: { key: hashKey || '', name: guest.name, devId: guest.devId } }));
      }
    });
    peer.on('connection', (c) => {
      if (!me || !c.metadata || c.metadata.key !== me.key) { c.on('open', () => c.close()); return; } // kunci salah
      const name = String(c.metadata.name || 'HP').slice(0, 60);
      // Perangkat dikenali dari devId (browser) atau namanya (aplikasi)
      const d = getDevice(String(c.metadata.devId || 'name:' + name), name);
      if (d.conn && d.conn !== c) { const old = d.conn; d.conn = null; try { old.close(); } catch {} }
      bind(d, c);
    });
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', (err) => {
      const map = {
        'peer-unavailable': 'Laptop tidak ditemukan. Pastikan halaman Sambung terbuka di laptop, lalu scan ulang QR-nya.',
        'unavailable-id': 'Halaman ini sudah terbuka di tab lain. Tutup tab lain itu lalu muat ulang.',
        network: 'Tidak bisa menghubungi server pairing. Pastikan ada internet.',
        'server-error': 'Server pairing sedang bermasalah. Coba lagi sebentar.',
        'browser-incompatible': 'Browser ini tidak mendukung WebRTC.',
      };
      setStatus(map[err.type] || 'Error: ' + err.message, 'warn');
    });
  }

  function bind(d, c) {
    d.conn = c;
    c.on('open', async () => {
      const dc = c.dataChannel;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 1 << 20;
      d.online = true;
      // HP yang hilang tanpa pamit (Wi-Fi mati, aplikasi ditutup paksa) ditandai offline
      const pc = c.peerConnection; let lost = null;
      pc && pc.addEventListener('iceconnectionstatechange', () => {
        const s = pc.iceConnectionState;
        clearTimeout(lost);
        if (s === 'failed' || s === 'closed') c.close();
        else if (s === 'disconnected') lost = setTimeout(() => c.close(), 6000);
      });
      d.route = await routeType(c);
      if (isHost) sendTo(d, { t: 'welcome', name: document.title });
      addMsg(d, 'Terhubung ' + d.route, 'sys');
      if (isHost) {
        if (!selected || !devices.get(selected)?.online) select(d.id); else { renderList(); if (selected === d.id) select(d.id); }
      } else {
        setStatus('Terhubung ke laptop', 'ok', d.route);
        select(d.id);
      }
    });
    // Proses pesan berurutan per perangkat: potongan file tidak boleh diproses sebelum file-meta selesai
    let rxChain = Promise.resolve();
    c.on('data', (x) => { rxChain = rxChain.then(() => onData(d, x)).catch((e) => addMsg(d, 'Error: ' + esc(e.message), 'sys')); });
    c.on('close', () => {
      if (d.conn !== c) return;
      d.conn = null;
      d.online = false;
      for (const f of d.incoming.values()) { try { f.writer && f.writer.abort(); } catch {} }
      d.incoming.clear(); d.currentRx = null; d.backupEl = null;
      addMsg(d, isHost ? `${esc(d.name)} terputus` : 'Laptop terputus', 'sys');
      if (selected === d.id) select(d.id); else renderList();
      if (!isHost) setStatus('Terputus. Scan ulang QR di laptop untuk menyambung lagi.', 'warn');
    });
    c.on('error', (e) => { if (!isHost) setStatus('Koneksi gagal: ' + e.message, 'warn'); });
  }

  // ---------- QR (laptop) ----------
  function renderQR(id) {
    const url = location.origin + location.pathname + location.search + '#' + id + '.' + me.key;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    $('joinLink').textContent = url;
  }

  // ---------- Data ----------
  const sendTo = (d, o) => d.conn && d.conn.open && d.conn.send(JSON.stringify(o));

  async function onData(d, x) {
    if (typeof x !== 'string') {
      const f = d.currentRx && d.incoming.get(d.currentRx);
      if (!f) return;
      f.got += x.byteLength;
      if (f.writer) f.chain = f.chain.then(() => f.writer.write(x));
      else f.parts.push(x);
      if (!f.quiet || f.got === f.meta.size) f.bar.value = f.got;
      return;
    }
    const m = JSON.parse(x);
    if (m.t === 'bye') { d.conn && d.conn.close(); return; }
    if (m.t === 'chat') { addMsg(d, esc(m.text)); return; }
    if (m.t === 'check') {
      // Aplikasi menanyakan file mana yang belum ada di folder laptop
      if (!dirHandle) { sendTo(d, { t: 'need', id: m.id, canSave: false, need: [] }); return; }
      const need = [];
      for (let i = 0; i < m.files.length; i++) {
        const f = m.files[i];
        if ((await fileSize(targetParts(d, { mode: 'backup', path: f.path }))) !== f.size) need.push(i);
      }
      sendTo(d, { t: 'need', id: m.id, canSave: true, need });
      return;
    }
    if (m.t === 'file-meta') {
      d.currentRx = m.id;
      const quiet = m.mode === 'backup';
      let el, bar;
      if (!quiet || !d.backupEl) {
        el = addMsg(d, `📄 <span class="fname">${esc(m.name)}</span> (${fmtSize(m.size)})<br><progress max="${m.size || 1}" value="0"></progress>`);
        bar = el.querySelector('progress');
        if (quiet) d.backupEl = el;
      } else {
        el = d.backupEl;
        el.querySelector('.fname').textContent = m.path || m.name;
        bar = el.querySelector('progress'); bar.max = m.size || 1;
      }
      const f = { meta: m, parts: [], got: 0, el, bar, quiet, chain: Promise.resolve(), writer: null };
      if (dirHandle) {
        try {
          const parts = targetParts(d, m);
          const dir = await getDir(parts.slice(0, -1), true);
          const name = m.mode === 'backup' ? parts[parts.length - 1] : await uniqueName(dir, parts[parts.length - 1]);
          const fh = await dir.getFileHandle(name, { create: true });
          f.writer = await fh.createWritable();
          f.savedAs = [...parts.slice(0, -1), name].join('/');
        } catch (e) {
          f.error = e.message;
        }
      }
      d.incoming.set(m.id, f);
      return;
    }
    if (m.t === 'file-end') {
      const f = d.incoming.get(m.id);
      if (!f) return;
      d.incoming.delete(m.id); d.currentRx = null;
      if (f.error) { sendTo(d, { t: 'ack', id: m.id, saved: false, error: f.error }); return; }
      try {
        if (f.writer) {
          await f.chain;
          await f.writer.close();
          if (f.quiet) {
            d.backupCount++;
            f.el.querySelector('.fname').textContent = `Backup: ${d.backupCount} file tersimpan (terakhir: ${f.meta.path || f.meta.name})`;
            d.last = `Backup: ${d.backupCount} file tersimpan`; d.lastAt = new Date(); renderList();
          } else {
            setBody(f.el, `📄 ${esc(f.meta.name)} (${fmtSize(f.meta.size)})<br><small>Tersimpan di ${esc(dirHandle.name ? dirHandle.name + '/' : '')}${esc(f.savedAs)}</small>`);
          }
        } else {
          const url = URL.createObjectURL(new Blob(f.parts, { type: f.meta.type || 'application/octet-stream' }));
          setBody(f.el, `📄 <a href="${url}" download="${esc(f.meta.name)}">${esc(f.meta.name)}</a> (${fmtSize(f.meta.size)})`);
        }
        sendTo(d, { t: 'ack', id: m.id, saved: true });
      } catch (e) {
        sendTo(d, { t: 'ack', id: m.id, saved: false, error: e.message });
      }
    }
  }

  const current = () => selected && devices.get(selected);

  function sendChat() {
    const d = current();
    const text = $('text').value.trim();
    if (!text || !d || !d.online) return;
    sendTo(d, { t: 'chat', text });
    addMsg(d, esc(text), 'me');
    $('text').value = '';
  }

  const waitDrain = (d) => new Promise((r) => {
    const dc = d.conn.dataChannel;
    if (dc.bufferedAmount < 4 << 20) return r();
    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
  });

  function sendFile(file) {
    const d = current();
    if (!d) return;
    d.sendQueue = d.sendQueue.then(() => sendFileP2P(d, file)).catch((e) => addMsg(d, 'Gagal kirim: ' + esc(e.message), 'sys'));
  }
  async function sendFileP2P(d, file) {
    if (!d.online) throw new Error('perangkat offline');
    const id = randomId(8);
    const el = addMsg(d, `📄 ${esc(file.name)} (${fmtSize(file.size)})<br><progress max="${file.size || 1}" value="0"></progress>`, 'me');
    const bar = el.querySelector('progress');
    sendTo(d, { t: 'file-meta', id, name: file.name, size: file.size, type: file.type, mode: 'send' });
    for (let off = 0; off < file.size; off += CHUNK) {
      if (!d.online) throw new Error('koneksi terputus');
      await waitDrain(d);
      d.conn.send(await file.slice(off, off + CHUNK).arrayBuffer());
      bar.value = Math.min(off + CHUNK, file.size);
    }
    sendTo(d, { t: 'file-end', id });
    setBody(el, `📄 ${esc(file.name)} (${fmtSize(file.size)})`);
  }

  // ---------- Event UI ----------
  $('sendBtn').onclick = sendChat;
  $('text').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  $('fileBtn').onclick = () => { if (current()?.online) $('file').click(); };
  $('file').onchange = () => { [...$('file').files].forEach(sendFile); $('file').value = ''; };
  $('devList').onclick = (e) => { const el = e.target.closest('.dev'); if (el) select(el.dataset.id); };
  $('devList').onkeydown = (e) => { const el = e.target.closest('.dev'); if (el && e.key === 'Enter') select(el.dataset.id); };
  $('newDev').onclick = () => select(null);
  $('backBtn').onclick = () => select(null);
  // Seret & lepas file ke panel percakapan
  let dragDepth = 0;
  const card = $('chatCard');
  card.addEventListener('dragenter', (e) => { if (!current()?.online) return; e.preventDefault(); dragDepth++; $('drop').classList.remove('hidden'); });
  card.addEventListener('dragover', (e) => { if (current()?.online) e.preventDefault(); });
  card.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.add('hidden'); } });
  card.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('drop').classList.add('hidden');
    [...(e.dataTransfer?.files || [])].forEach(sendFile);
  });
  $('resetBtn').onclick = (e) => { e.preventDefault(); hostIdentity(true); location.reload(); };

  // Beri tahu pasangan saat tab ditutup
  addEventListener('pagehide', () => { for (const d of devices.values()) { try { sendTo(d, { t: 'bye' }); } catch {} } });

  if (!isHost) { $('pairCard').classList.add('hidden'); $('devSection').classList.add('hidden'); $('backBtn').classList.add('hidden'); }
  initFolder();
  startPeer();
})();
