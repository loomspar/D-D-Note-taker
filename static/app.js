// Session Scribe front end: recording, uploading and viewing notes.

const CHUNK_MS = 5 * 60 * 1000; // each 5-minute piece is uploaded and transcribed while you keep playing
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const type = res.headers.get("Content-Type") || "";
  if (res.status === 204) return null;
  return type.includes("json") ? res.json() : res.text();
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2500);
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const fmtDate = (ts) =>
  new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const STATUS_LABELS = {
  recording: "Recording",
  preparing: "Preparing",
  transcribing: "Transcribing",
  generating: "Writing notes",
  done: "Notes ready",
  error: "Error",
};

function showView(name) {
  for (const v of ["home", "record", "session"]) $(`view-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
}

// ---------- routing ----------

let pollTimer = null;

function route() {
  clearTimeout(pollTimer);
  const [, view, id] = location.hash.split("/");
  if (view === "record" && rec && rec.session.id === id) return showView("record");
  if (view === "session" && id) return openSession(id);
  showView("home");
  loadHome();
}

window.addEventListener("hashchange", route);

// ---------- home ----------

async function loadHome() {
  const [settings, sessions] = await Promise.all([api("/api/settings"), api("/api/sessions")]);
  if (document.activeElement !== $("campaign")) $("campaign").value = settings.campaign_context || "";
  const list = $("session-list");
  if (!sessions.length) {
    list.innerHTML = `<div class="empty">No sessions yet. Your first one will show up here.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const s of sessions) {
    const a = document.createElement("a");
    a.className = "session-item";
    a.href = `#/session/${s.id}`;
    a.innerHTML = `<div><div class="name"></div><div class="muted small">${fmtDate(s.created_at)}</div></div>
      <span class="badge ${s.status}">${STATUS_LABELS[s.status] || s.status}</span>`;
    a.querySelector(".name").textContent = s.title;
    list.appendChild(a);
  }
}

$("btn-save-campaign").onclick = async () => {
  await api("/api/settings", json("PUT", { campaign_context: $("campaign").value }));
  $("campaign-saved").textContent = "Saved ✓";
  setTimeout(() => ($("campaign-saved").textContent = ""), 2000);
};

// ---------- uploading an existing recording ----------

$("file-input").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  form.append("title", $("new-title").value);
  const xhr = new XMLHttpRequest();
  $("upload-progress").hidden = false;
  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) return;
    const pct = Math.round((ev.loaded / ev.total) * 100);
    $("upload-bar").style.width = pct + "%";
    $("upload-label").textContent = `Uploading… ${pct}%`;
  };
  xhr.onload = () => {
    $("upload-progress").hidden = true;
    e.target.value = "";
    if (xhr.status >= 300) return toast("Upload failed: " + xhr.responseText);
    $("new-title").value = "";
    location.hash = `#/session/${JSON.parse(xhr.responseText).id}`;
  };
  xhr.onerror = () => {
    $("upload-progress").hidden = true;
    toast("Upload failed. Is the server still running?");
  };
  xhr.open("POST", "/api/sessions/upload");
  xhr.send(form);
};

// ---------- recording ----------

let rec = null;

function pickMimeType() {
  const options = [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["audio/mp4", "mp4"],
    ["audio/webm", "webm"],
  ];
  for (const [type, ext] of options) if (MediaRecorder.isTypeSupported(type)) return { type, ext };
  return { type: "", ext: "webm" };
}

$("btn-record").onclick = async () => {
  let stream;
  try {
    // Turn off the voice-call processing: it's tuned for one person near the mic, not a whole table.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch (err) {
    return toast("Microphone access is needed to record. Check your browser's permission settings.");
  }
  const session = await api("/api/sessions", json("POST", { title: $("new-title").value }));
  $("new-title").value = "";
  rec = {
    session,
    stream,
    mime: pickMimeType(),
    index: 0,
    paused: false,
    elapsed: 0,
    segmentStart: Date.now(),
    uploads: new Set(),
    finishing: false,
  };
  startMeter(stream);
  requestWakeLock();
  startSegment();
  setRecordingUI();
  $("live-transcript").textContent = "Transcript will appear here a few minutes in…";
  $("live-count").textContent = "";
  location.hash = `#/record/${session.id}`;
  tickTimer();
  pollLiveTranscript();
};

function startSegment() {
  const index = rec.index++;
  const mr = new MediaRecorder(rec.stream, {
    ...(rec.mime.type && { mimeType: rec.mime.type }),
    audioBitsPerSecond: 64000,
  });
  const parts = [];
  mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
  mr.onstop = () => {
    const blob = new Blob(parts, { type: rec.mime.type || "audio/webm" });
    if (blob.size) uploadChunk(index, blob);
    mr._done && mr._done();
  };
  mr.start(10000);
  rec.recorder = mr;
  rec.segmentStart = Date.now();
  rec.rotateTimer = setTimeout(() => {
    stopSegment();
    startSegment();
  }, CHUNK_MS);
}

function stopSegment() {
  clearTimeout(rec.rotateTimer);
  const mr = rec.recorder;
  rec.recorder = null;
  if (!mr || mr.state === "inactive") return Promise.resolve();
  rec.elapsed += Date.now() - rec.segmentStart;
  return new Promise((resolve) => {
    mr._done = resolve;
    mr.stop();
  });
}

function uploadChunk(index, blob) {
  const { id } = rec.session;
  const ext = rec.mime.ext;
  const attempt = async (tries) => {
    const form = new FormData();
    form.append("audio", blob, `${index}.${ext}`);
    try {
      await api(`/api/sessions/${id}/chunks?index=${index}&ext=${ext}`, { method: "POST", body: form });
    } catch (err) {
      // Keep retrying: the audio is held in memory until the server has it.
      if (tries > 60) throw err;
      $("rec-sub").textContent = "Having trouble reaching the server — will keep retrying…";
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * tries)));
      return attempt(tries + 1);
    }
    $("rec-sub").textContent = "Audio is saved every few minutes, so nothing is lost if something goes wrong.";
  };
  const p = attempt(1).catch(() => toast(`A piece of the recording (#${index + 1}) couldn't be saved.`));
  rec.uploads.add(p);
  p.finally(() => rec && rec.uploads.delete(p));
}

$("btn-pause").onclick = async () => {
  if (!rec) return;
  if (rec.paused) {
    rec.paused = false;
    startSegment();
  } else {
    rec.paused = true;
    await stopSegment();
  }
  setRecordingUI();
};

$("btn-stop").onclick = async () => {
  if (!rec || rec.finishing) return;
  if (!confirm("End the session and write notes?")) return;
  rec.finishing = true;
  $("btn-stop").disabled = $("btn-pause").disabled = true;
  $("btn-stop").textContent = "Saving the last of the audio…";
  await stopSegment();
  await Promise.allSettled([...rec.uploads]);
  const id = rec.session.id;
  rec.stream.getTracks().forEach((t) => t.stop());
  stopMeter();
  releaseWakeLock();
  clearTimeout(rec.livePoll);
  rec = null;
  try {
    await api(`/api/sessions/${id}/finish`, { method: "POST" });
  } catch (err) {
    toast("Couldn't tell the server the session ended. Open it from the home page to retry.");
  }
  $("btn-stop").disabled = $("btn-pause").disabled = false;
  $("btn-stop").textContent = "End Session & Write Notes";
  location.hash = `#/session/${id}`;
};

function setRecordingUI() {
  const dot = rec.paused ? "paused" : "live";
  $("rec-status").innerHTML = `<span class="rec-dot ${dot}"></span> ${rec.paused ? "Paused" : "Recording"}`;
  $("btn-pause").textContent = rec.paused ? "Resume" : "Pause";
}

function tickTimer() {
  if (!rec) return;
  const ms = rec.elapsed + (rec.recorder ? Date.now() - rec.segmentStart : 0);
  $("timer").textContent = fmtDuration(ms);
  setTimeout(tickTimer, 500);
}

async function pollLiveTranscript() {
  if (!rec) return;
  const { id } = rec.session;
  try {
    const [text, s] = await Promise.all([
      api(`/api/sessions/${id}/transcript`),
      api(`/api/sessions/${id}`),
    ]);
    if (text.trim()) {
      const el = $("live-transcript");
      el.textContent = text.split("\n").slice(-60).join("\n");
      el.classList.remove("muted");
      el.scrollTop = el.scrollHeight;
    }
    $("live-count").textContent = s.chunks_received
      ? `· ${s.chunks_transcribed} of ${s.chunks_received} saved parts transcribed`
      : "";
  } catch {}
  if (rec) rec.livePoll = setTimeout(pollLiveTranscript, 20000);
}

window.addEventListener("beforeunload", (e) => {
  if (rec) {
    e.preventDefault();
    e.returnValue = "";
  }
});

document.querySelector(".brand").addEventListener("click", (e) => {
  if (rec) {
    e.preventDefault();
    toast("Recording is still going — end the session first.");
  }
});

// Keep the screen from sleeping (which can pause recording on some devices).
let wakeLock = null;
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (rec && document.visibilityState === "visible") requestWakeLock();
});

// Audio level meter, so you can see the mic is picking people up.
let meter = null;
function startMeter(stream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const canvas = $("meter");
  const g = canvas.getContext("2d");
  const history = new Array(120).fill(0);
  meter = { ctx, raf: 0 };
  const draw = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    history.push(rec && rec.paused ? 0 : Math.min(1, Math.sqrt(sum / data.length) * 4));
    history.shift();
    g.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width / history.length;
    g.fillStyle = "#d9a441";
    history.forEach((v, i) => {
      const h = Math.max(2, v * canvas.height);
      g.fillRect(i * w + 1, (canvas.height - h) / 2, w - 2, h);
    });
    meter.raf = requestAnimationFrame(draw);
  };
  draw();
}
function stopMeter() {
  if (!meter) return;
  cancelAnimationFrame(meter.raf);
  meter.ctx.close();
  meter = null;
}

// ---------- session / notes view ----------

let current = null; // { session, markdown }

async function openSession(id) {
  showView("session");
  $("notes").hidden = $("transcript").hidden = $("tabs").hidden = true;
  $("progress-card").hidden = $("error-card").hidden = true;
  current = null;
  await refreshSession(id);
}

async function refreshSession(id) {
  let s;
  try {
    s = await api(`/api/sessions/${id}`);
  } catch {
    toast("That session couldn't be found.");
    location.hash = "#/";
    return;
  }
  if (location.hash !== `#/session/${id}`) return;
  const firstLoad = !current || current.session.id !== id;
  const statusChanged = firstLoad || current.session.status !== s.status;
  current = { ...(current || {}), session: s };

  $("session-title").textContent = s.title;
  $("session-date").textContent = fmtDate(s.created_at);
  document.title = `${s.title} · Session Scribe`;

  showProgress(s);
  $("error-card").hidden = s.status !== "error";
  if (s.status === "error") $("error-text").textContent = s.error || "Unknown error";

  if (s.status === "done" && statusChanged) {
    const md = await api(`/api/sessions/${id}/notes`);
    current.markdown = md;
    $("notes").innerHTML = DOMPurify.sanitize(marked.parse(md));
    selectTab("notes");
  }
  $("tabs").hidden = !(s.status === "done" || s.status === "error");
  if (s.status === "error" && statusChanged) selectTab("transcript");

  if (!["done", "error"].includes(s.status)) pollTimer = setTimeout(() => refreshSession(id), 3000);
}

function showProgress(s) {
  const card = $("progress-card");
  card.hidden = ["done", "error"].includes(s.status);
  const title = $("progress-title");
  const detail = $("progress-detail");
  card.querySelector(".spinner").hidden = s.status === "recording";
  if (s.status === "recording") {
    title.textContent = "This recording was interrupted before it was finished.";
    detail.innerHTML = `${s.chunks_received} part(s) were saved. <button class="btn btn-small" id="btn-finish-orphan">Write notes from what was saved</button>`;
    $("btn-finish-orphan").onclick = async () => {
      await api(`/api/sessions/${s.id}/finish`, { method: "POST" });
      refreshSession(s.id);
    };
  } else if (s.status === "preparing") {
    title.textContent = "Preparing your recording…";
    detail.textContent = "Splitting the audio into pieces for transcription.";
  } else if (s.status === "transcribing") {
    title.textContent = "Transcribing the session…";
    detail.textContent = `${s.chunks_transcribed} of ${s.chunks_received} parts done. Long recordings can take a while — you can leave this page and come back.`;
  } else if (s.status === "generating") {
    title.textContent = "Writing your session notes…";
    detail.textContent = "Reading through everything that happened. This usually takes a minute or two.";
  }
}

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  const hasNotes = !!current?.markdown && current.session.status === "done";
  $("notes").hidden = name !== "notes" || !hasNotes;
  $("transcript").hidden = name !== "transcript";
  if (name === "transcript") {
    $("transcript").textContent = "Loading…";
    api(`/api/sessions/${current.session.id}/transcript`).then(
      (t) => ($("transcript").textContent = t || "No speech was transcribed.")
    );
  }
}

document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));

$("session-title").onclick = async () => {
  if (!current) return;
  const title = prompt("Rename this session:", current.session.title);
  if (!title || !title.trim()) return;
  current.session = await api(`/api/sessions/${current.session.id}`, json("PATCH", { title }));
  $("session-title").textContent = current.session.title;
};

$("btn-copy").onclick = async () => {
  if (!current?.markdown) return toast("No notes yet.");
  await navigator.clipboard.writeText(current.markdown);
  toast("Notes copied (Markdown)");
};

$("btn-download").onclick = () => {
  if (!current?.markdown) return toast("No notes yet.");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([current.markdown], { type: "text/markdown" }));
  a.download = current.session.title.replace(/[^\w\- ]+/g, "").trim() + ".md";
  a.click();
  URL.revokeObjectURL(a.href);
};

$("btn-print").onclick = () => {
  selectTab("notes");
  window.print();
};

async function regenerate() {
  if (!current) return;
  await api(`/api/sessions/${current.session.id}/regenerate`, { method: "POST" });
  $("notes").hidden = $("tabs").hidden = $("error-card").hidden = true;
  refreshSession(current.session.id);
}
$("btn-regen").onclick = () => confirm("Rewrite the notes from the transcript? The current notes will be replaced.") && regenerate();
$("btn-retry").onclick = regenerate;

$("btn-delete").onclick = async () => {
  if (!current || !confirm(`Delete "${current.session.title}" and its recording? This can't be undone.`)) return;
  await api(`/api/sessions/${current.session.id}`, { method: "DELETE" });
  location.hash = "#/";
};

route();
