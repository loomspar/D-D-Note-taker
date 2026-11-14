// Gubbo on the phone: a microphone, a speaker and a caption. Everything else happens on the PC.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const caption = $('caption'), stateEl = $('state'), button = $('gubbo'), canvas = $('skin');
  let state = 'idle', recorder = null, stream = null, chunks = [], audioCtx = null, source = null, token = 0;

  const setState = (s, label) => { state = s; document.body.className = s; stateEl.textContent = label; };
  const say = (text, kind) => { caption.textContent = text; caption.className = kind || ''; };

  // Front view of the skin, drawn from the same texture the PC uses.
  const img = new Image();
  img.onload = () => {
    const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false;
    const legacy = img.height === 32;
    const part = (sx, sy, w, h, dx, dy, flip) => { g.save(); g.translate(dx + (flip ? w : 0), dy); if (flip) g.scale(-1, 1); g.drawImage(img, sx, sy, w, h, 0, 0, w, h); g.restore(); };
    part(8, 8, 8, 8, 4, 0); part(20, 20, 8, 12, 4, 8); part(44, 20, 4, 12, 0, 8); part(4, 20, 4, 12, 4, 20);
    if (legacy) { part(44, 20, 4, 12, 12, 8, true); part(4, 20, 4, 12, 8, 20, true); part(40, 8, 8, 8, 4, 0); return; }
    part(36, 52, 4, 12, 12, 8); part(20, 52, 4, 12, 8, 20);
    part(40, 8, 8, 8, 4, 0); part(20, 36, 8, 12, 4, 8); part(44, 36, 4, 12, 0, 8); part(52, 52, 4, 12, 12, 8); part(4, 36, 4, 12, 4, 20); part(4, 52, 4, 12, 8, 20);
  };
  img.src = '/skin.png';

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return buf;
  }

  function stopSpeaking() { token++; try { source && source.stop(); } catch (e) { /* not playing */ } source = null; }
  function releaseMic() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; recorder = null; }

  async function startListening() {
    stopSpeaking();
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();   // unlocked by this tap, so replies can play
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { say('I need the microphone. In Safari tap “aA” → Website Settings → Microphone → Allow, then try again. You can also type below.', 'problem'); setState('idle', 'Microphone blocked'); return; }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start(250);
    say('', ''); setState('listening', 'Listening — tap again to send');
  }

  async function stopAndSend() {
    const rec = recorder;
    setState('thinking', 'Sending to your PC…');
    await new Promise((r) => { rec.onstop = r; try { rec.stop(); } catch (e) { r(); } });
    const blob = new Blob(chunks, { type: rec.mimeType }); chunks = []; releaseMic();   // mic is off before anything else
    let wav;
    try {
      const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());
      const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
      const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
      wav = encodeWav((await off.startRendering()).getChannelData(0), 16000);
    } catch (e) { say('That recording could not be read. Try again.', 'problem'); setState('idle', 'Ready'); return; }
    await turn(fetch('/api/talk', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav }));
  }

  async function turn(request) {
    const my = ++token;
    setState('thinking', 'Thinking…');
    let r;
    try { const res = await request; if (res.status === 401) { say('This phone is no longer paired. Scan the QR code on the PC again.', 'problem'); setState('idle', 'Not paired'); return; } r = await res.json(); }
    catch (e) { say('I can’t reach your PC. Is it on, with Gubbo Companion running, on the same Wi-Fi?', 'problem'); setState('idle', 'PC not reachable'); return; }
    if (r.heard) say('“' + r.heard + '”', 'heard');
    const parts = r.parts && r.parts.length ? r.parts : [r.reply];
    setState('speaking', 'Speaking — tap to stop');
    const fetchAudio = (t) => fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) }).then((x) => (x.status === 200 ? x.arrayBuffer() : null)).catch(() => null);
    let next = fetchAudio(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const data = await next;
      if (my !== token) return;
      if (i + 1 < parts.length) next = fetchAudio(parts[i + 1]);
      say(parts[i], r.ok ? '' : 'problem');
      if (data && audioCtx) {
        try {
          const buf = await audioCtx.decodeAudioData(data);
          await new Promise((res) => { source = audioCtx.createBufferSource(); source.buffer = buf; source.connect(audioCtx.destination); source.onended = res; source.start(); });
        } catch (e) { await new Promise((res) => setTimeout(res, 1200 + parts[i].length * 50)); }
      } else await new Promise((res) => setTimeout(res, 1200 + parts[i].length * 50));   // no voice on the PC yet: captions only
      if (my !== token) return;
    }
    say(r.reply.length > 400 ? parts[parts.length - 1] : r.reply, r.ok ? '' : 'problem');
    setState('idle', 'Ready');
  }

  button.addEventListener('click', () => {
    if (state === 'listening') void stopAndSend();
    else if (state === 'thinking') return;
    else if (state === 'speaking') { stopSpeaking(); setState('idle', 'Ready'); }
    else void startListening();
  });
  $('typed').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('text').value.trim();
    if (!text || state === 'thinking' || state === 'listening') return;
    stopSpeaking();
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    $('text').value = ''; $('text').blur();
    say('“' + text + '”', 'heard');
    void turn(fetch('/api/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'listening') { try { recorder && recorder.stop(); } catch (e) { /* stopped */ } releaseMic(); chunks = []; setState('idle', 'Ready'); } });
  if (!navigator.mediaDevices || !window.MediaRecorder) say('This browser can’t record here. You can still type below.', 'problem');
})();
