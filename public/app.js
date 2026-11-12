// Klien web: pairing via QR, koneksi WebRTC DataChannel, fallback relay via server laptop.
(() => {
  const $ = (id) => document.getElementById(id);
  const CHUNK = 16 * 1024;
  const P2P_TIMEOUT = 10000;

  const isHost = !location.hash.slice(1);
  const room = isHost ? randomId(6) : location.hash.slice(1);
  const me = randomId(8);
  let peer = null;        // id peer lawan
  let pc = null, dc = null;
  let mode = null;        // 'p2p' | 'relay' | null
  let fallbackTimer = null;
  const incoming = new Map(); // fileId -> { meta, parts, got, el }

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

  function showConnected() {
    $('pairCard').classList.add('hidden');
    $('chatCard').classList.remove('hidden');
    const label = mode === 'p2p' ? 'P2P langsung (WebRTC)' : 'lewat server laptop (relay)';
    setStatus('Terhubung', 'ok', '· ' + label);
    addMsg('Terhubung ' + label, 'sys');
  }
  function showWaiting() {
    $('chatCard').classList.add('hidden');
    if (isHost) $('pairCard').classList.remove('hidden');
    setStatus(isHost ? 'Menunggu HP scan QR…' : 'Menunggu laptop…', 'warn');
  }

  // ---------- QR (laptop) ----------
  async function setupQR() {
    const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    let hosts = [];
    if (!local) hosts = [location.host];
    else {
      try {
        const info = await (await fetch('/info')).json();
        hosts = info.addresses.map((a) => ({ label: `${a.address} (${a.name})`, host: `${a.address}:${info.port}` }));
      } catch { /* abaikan */ }
      if (hosts.length > 1) {
        const sel = $('ipSelect');
        hosts.forEach((h, i) => sel.add(new Option(h.label, i)));
        sel.onchange = () => renderQR(hosts[sel.value].host);
        $('ipPick').classList.remove('hidden');
      }
      hosts = hosts.length ? hosts : [{ host: location.host }];
    }
    renderQR(typeof hosts[0] === 'string' ? hosts[0] : hosts[0].host);
  }
  function renderQR(host) {
    const url = `http://${host}/#${room}`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $('joinLink').textContent = url;
  }

  // ---------- Signaling ----------
  function post(data, to) {
    return fetch('/signal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, from: me, to: to || peer, data }) });
  }

  const es = new EventSource(`/events?room=${encodeURIComponent(room)}&id=${me}`);
  es.onerror = () => setStatus('Koneksi ke server laptop terputus, mencoba lagi…', 'warn');
  es.onmessage = async (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'welcome') {
      showWaiting();
      if (ev.peers.length) { peer = ev.peers[0]; if (isHost) startPeer(); else armFallback(); }
    } else if (ev.type === 'peer-joined') {
      if (peer && mode) return; // sudah ada pasangan
      peer = ev.from;
      if (isHost) startPeer(); else armFallback();
    } else if (ev.type === 'peer-left') {
      if (ev.from !== peer) return;
      addMsg('Perangkat lain terputus', 'sys');
      teardown();
      showWaiting();
    } else if (ev.type === 'signal') {
      if (peer && ev.from !== peer) return;
      peer = ev.from;
      await onSignal(ev.data);
    } else if (ev.type === 'relay-file') {
      addMsg(`📄 <a href="/file/${ev.id}" download="${esc(ev.name)}">${esc(ev.name)}</a> (${fmtSize(ev.size)})`);
    }
  };

  // ---------- WebRTC ----------
  function newPC() {
    // Tanpa STUN/TURN: hanya kandidat jaringan lokal (Wi-Fi/hotspot yang sama)
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (e) => { if (e.candidate) post({ candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (pc && pc.connectionState === 'failed' && mode !== 'relay') useRelay();
    };
    pc.ondatachannel = (e) => bindDC(e.channel);
  }
  async function startPeer() {
    teardown(true);
    newPC();
    bindDC(pc.createDataChannel('data', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    post({ sdp: pc.localDescription });
    armFallback();
  }
  async function onSignal(data) {
    if (data.kind === 'chat') { if (!mode) useRelay(true); return addMsg(esc(data.text)); }
    if (data.kind === 'relay') { if (!mode) useRelay(true); return; }
    if (data.sdp) {
      if (data.sdp.type === 'offer') { teardown(true); newPC(); armFallback(); }
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        post({ sdp: pc.localDescription });
      }
    } else if (data.candidate && pc) {
      try { await pc.addIceCandidate(data.candidate); } catch { /* kandidat basi */ }
    }
  }
  function bindDC(ch) {
    dc = ch;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1 << 20;
    dc.onopen = () => {
      clearTimeout(fallbackTimer);
      const wasRelay = mode === 'relay';
      mode = 'p2p';
      if (wasRelay) { setStatus('Terhubung', 'ok', '· P2P langsung (WebRTC)'); addMsg('Beralih ke P2P langsung', 'sys'); }
      else showConnected();
    };
    dc.onclose = () => { if (mode === 'p2p') { mode = null; } };
    dc.onmessage = (e) => onData(e.data);
  }
  function armFallback() {
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => { if (mode !== 'p2p') useRelay(); }, P2P_TIMEOUT);
  }
  function useRelay(fromPeer) {
    if (mode) return;
    clearTimeout(fallbackTimer);
    mode = 'relay';
    if (!fromPeer) post({ kind: 'relay' });
    showConnected();
  }
  function teardown(keepPeer) {
    clearTimeout(fallbackTimer);
    try { dc && dc.close(); } catch {}
    try { pc && pc.close(); } catch {}
    pc = dc = null;
    mode = null;
    if (!keepPeer) peer = null;
  }

  // ---------- Data ----------
  let currentRx = null;
  function onData(d) {
    if (typeof d !== 'string') {
      const f = currentRx && incoming.get(currentRx);
      if (!f) return;
      f.parts.push(d); f.got += d.byteLength;
      f.bar.value = f.got;
      return;
    }
    const m = JSON.parse(d);
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
    if (!text || !mode) return;
    if (mode === 'p2p') dc.send(JSON.stringify({ t: 'chat', text }));
    else post({ kind: 'chat', text });
    addMsg(esc(text), 'me');
    $('text').value = '';
  }

  const waitDrain = () => new Promise((r) => {
    if (dc.bufferedAmount < 4 << 20) return r();
    dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
  });

  let sendQueue = Promise.resolve();
  function sendFile(file) {
    sendQueue = sendQueue.then(() => (mode === 'p2p' ? sendFileP2P(file) : sendFileRelay(file))).catch((e) => addMsg('Gagal kirim: ' + esc(e.message), 'sys'));
  }
  async function sendFileP2P(file) {
    const id = randomId(8);
    const el = addMsg(`📄 ${esc(file.name)} (${fmtSize(file.size)})<br><progress max="${file.size || 1}" value="0"></progress>`, 'me');
    const bar = el.querySelector('progress');
    dc.send(JSON.stringify({ t: 'file-meta', id, name: file.name, size: file.size, type: file.type }));
    for (let off = 0; off < file.size; off += CHUNK) {
      await waitDrain();
      dc.send(await file.slice(off, off + CHUNK).arrayBuffer());
      bar.value = Math.min(off + CHUNK, file.size);
    }
    dc.send(JSON.stringify({ t: 'file-end', id }));
    el.innerHTML = `📄 ${esc(file.name)} (${fmtSize(file.size)}) ✓ terkirim`;
  }
  function sendFileRelay(file) {
    return new Promise((resolve, reject) => {
      const el = addMsg(`📄 ${esc(file.name)} (${fmtSize(file.size)})<br><progress max="1" value="0"></progress>`, 'me');
      const bar = el.querySelector('progress');
      const x = new XMLHttpRequest();
      x.open('POST', `/upload?room=${encodeURIComponent(room)}&from=${me}&name=${encodeURIComponent(file.name)}`);
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = e.loaded / e.total; };
      x.onload = () => { if (x.status === 200) { el.innerHTML = `📄 ${esc(file.name)} (${fmtSize(file.size)}) ✓ terkirim`; resolve(); } else reject(new Error(x.responseText || x.status)); };
      x.onerror = () => reject(new Error('jaringan'));
      x.send(file);
    });
  }

  $('sendBtn').onclick = sendChat;
  $('text').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  $('fileBtn').onclick = () => $('file').click();
  $('file').onchange = () => { [...$('file').files].forEach(sendFile); $('file').value = ''; };

  if (isHost) setupQR(); else $('pairCard').classList.add('hidden');
  setStatus('Menyambung ke server…');
})();
