// StemSplit: a phone-friendly front end for Hugging Face stem-separation Spaces,
// with a local library (IndexedDB) and a multitrack stem mixer.

const GRADIO_CDN = "https://cdn.jsdelivr.net/npm/@gradio/client@2.8.0/dist/index.min.js";
const GRADIO_CDN_FALLBACK = "https://esm.sh/@gradio/client@2.8.0";

const SUGGESTED_SPACES = [
  { id: "teamup-tech/demucs-source-separation", note: "4 stems · GPU" },
  { id: "YOUR-NAME/stemsplit", note: "your own · 6 stems incl. guitar" },
  { id: "cwitkowitz/demucs-cpu", note: "1 stem at a time · CPU" },
];
const DEFAULT_SPACE = SUGGESTED_SPACES[0].id;

const STEM_COLORS = [
  [/vocal|voice|sing/i, "#ff7aa8"],
  [/drum|perc|beat/i, "#ffb347"],
  [/bass/i, "#7c9cff"],
  [/guitar/i, "#4fd18b"],
  [/piano|key/i, "#c792ea"],
  [/instrument|accomp|no.?vocal|karaoke/i, "#5ad1e6"],
  [/other|rest|remain/i, "#a0a8b8"],
  [/original|mix/i, "#e0e0e0"],
];
const colorFor = (n) => (STEM_COLORS.find(([re]) => re.test(n)) || [0, "#8fa3c7"])[1];

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};
const fmtTime = (s) => {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

/* ---------------- settings ---------------- */
const settings = {
  get space() { return localStorage.getItem("ss.space") || DEFAULT_SPACE; },
  set space(v) { localStorage.setItem("ss.space", v.trim()); },
  get token() { return localStorage.getItem("ss.token") || ""; },
  set token(v) { v ? localStorage.setItem("ss.token", v.trim()) : localStorage.removeItem("ss.token"); },
  get keepOriginal() { return localStorage.getItem("ss.keepOrig") !== "0"; },
  set keepOriginal(v) { localStorage.setItem("ss.keepOrig", v ? "1" : "0"); },
  params(space) { try { return JSON.parse(localStorage.getItem("ss.params." + space) || "{}"); } catch { return {}; } },
  saveParams(space, obj) { localStorage.setItem("ss.params." + space, JSON.stringify(obj)); },
};

/* ---------------- IndexedDB ---------------- */
const db = {
  _p: null,
  open() {
    return (this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open("stemsplit", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("tracks", { keyPath: "id" });
        d.createObjectStore("blobs");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async tx(stores, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => (out = v));
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Storage aborted (phone storage may be full)"));
    });
  },
  req: (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
  async allTracks() {
    return this.tx(["tracks"], "readonly", (t) => this.req(t.objectStore("tracks").getAll()));
  },
  async getTrack(id) {
    return this.tx(["tracks"], "readonly", (t) => this.req(t.objectStore("tracks").get(id)));
  },
  async putTrack(track) {
    return this.tx(["tracks"], "readwrite", (t) => t.objectStore("tracks").put(track));
  },
  async getBlob(key) {
    return this.tx(["blobs"], "readonly", (t) => this.req(t.objectStore("blobs").get(key)));
  },
  async saveNew(track, blobs) {
    return this.tx(["tracks", "blobs"], "readwrite", (t) => {
      for (const [k, b] of blobs) t.objectStore("blobs").put(b, k);
      t.objectStore("tracks").put(track);
    });
  },
  async deleteTrack(track) {
    return this.tx(["tracks", "blobs"], "readwrite", (t) => {
      for (const s of track.stems) t.objectStore("blobs").delete(s.key);
      t.objectStore("tracks").delete(track.id);
    });
  },
  async wipe() {
    return this.tx(["tracks", "blobs"], "readwrite", (t) => {
      t.objectStore("tracks").clear();
      t.objectStore("blobs").clear();
    });
  },
};

/* ---------------- navigation ---------------- */
const TITLES = { separate: "Separate", library: "Library", settings: "Settings", player: "Mixer" };
function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view || (view === "player" && t.dataset.view === "library")));
  $("#viewTitle").textContent = TITLES[view];
  if (view !== "player") player.close();
  if (view === "library") renderLibrary();
  if (view === "settings") fillSettings();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => show(t.dataset.view)));

/* ---------------- Gradio connection ---------------- */
let gradioMod = null;
async function loadGradio() {
  if (gradioMod) return gradioMod;
  try { gradioMod = await import(GRADIO_CDN); }
  catch { gradioMod = await import(GRADIO_CDN_FALLBACK); }
  return gradioMod;
}

const FILE_COMPONENTS = /^(audio|file|video|uploadbutton|files)$/i;
let conn = null; // { space, app, api, endpoint, info, fileIdx, extra:[{idx,label,kind,choices,default}] }

async function connect(onStatus = () => {}) {
  const space = settings.space;
  if (conn && conn.space === space && conn.token === settings.token) return conn;
  const { Client } = await loadGradio();
  const opts = {
    status_callback: (s) => {
      const st = (s.status || "").toLowerCase();
      if (st === "sleeping" || st === "starting" || st === "building")
        onStatus(`Space is waking up (${st})… this can take a minute or two.`);
      else if (s.message) onStatus(s.message);
    },
  };
  if (settings.token) { opts.token = settings.token; opts.hf_token = settings.token; }
  const app = await Client.connect(space, opts);
  const api = await app.view_api();
  const pick = pickEndpoint(api);
  if (!pick) throw new Error("This Space has no endpoint that takes an audio file. Pick a different Space in Settings.");
  const extra = describeParams(app, pick);
  conn = { space, token: settings.token, app, api, ...pick, extra };
  return conn;
}

function pickEndpoint(api) {
  let best = null;
  for (const [name, info] of Object.entries(api.named_endpoints || {})) {
    const fileIdx = info.parameters.findIndex((p) => FILE_COMPONENTS.test(p.component || ""));
    if (fileIdx < 0) continue;
    const audioOut = info.returns.filter((r) => /audio|file/i.test(r.component || "")).length;
    if (!audioOut) continue;
    const score = audioOut * 10 + (/sep|split|stem|demix|process|predict|run/i.test(name) ? 5 : 0) - info.parameters.length;
    if (!best || score > best.score) best = { endpoint: name, info, fileIdx, score };
  }
  return best;
}

function describeParams(app, { endpoint, info, fileIdx }) {
  const cfg = app.config || {};
  const comps = cfg.components || [];
  const dep = (cfg.dependencies || []).find((d) => "/" + d.api_name === endpoint);
  const depInputs = dep ? dep.inputs.map((id) => comps.find((c) => c.id === id)).filter(Boolean) : [];
  return info.parameters.map((p, idx) => {
    if (idx === fileIdx) return null;
    const comp = depInputs.find((c) => c.props?.label && c.props.label === p.label) || depInputs[idx];
    let choices = comp?.props?.choices || null;
    if (choices) choices = choices.map((c) => (Array.isArray(c) ? { label: c[0], value: c[1] } : { label: String(c), value: c }));
    const pt = (p.python_type?.type || "").toLowerCase();
    const kind = choices ? "select" : pt === "bool" ? "bool" : /float|int/.test(pt) ? "number" : "text";
    const def = p.parameter_has_default ? p.parameter_default : (comp?.props?.value ?? p.example_input);
    return { idx, label: p.label || p.parameter_name || `Option ${idx + 1}`, name: p.parameter_name, kind, choices, default: def };
  }).filter(Boolean);
}

function renderParams() {
  const box = $("#paramBox");
  box.innerHTML = "";
  $("#spaceLabel").textContent = settings.space;
  if (!conn) {
    box.append(el("div", { className: "muted small", textContent: "Connects to the Space when you start (or test it in Settings)." }));
    return;
  }
  const saved = settings.params(conn.space);
  for (const p of conn.extra) {
    const key = p.name || p.label;
    const val = key in saved ? saved[key] : p.default;
    let input;
    if (p.kind === "select") {
      input = el("select", { className: "input" });
      for (const c of p.choices) input.append(el("option", { value: JSON.stringify(c.value), textContent: c.label }));
      input.value = JSON.stringify(val ?? p.choices[0]?.value);
      if (input.selectedIndex < 0) input.selectedIndex = 0;
    } else if (p.kind === "bool") {
      input = el("input", { type: "checkbox", checked: !!val });
    } else {
      input = el("input", { className: "input", type: p.kind === "number" ? "number" : "text", value: val ?? "" });
      if (p.kind === "number") input.step = "any";
    }
    input.dataset.key = key;
    input.onchange = saveParamValues;
    box.append(el("label", { textContent: p.label }), input);
  }
  if (!conn.extra.length) box.append(el("div", { className: "muted small", textContent: `Endpoint ${conn.endpoint} · no extra options` }));
}

function readParamValues() {
  const vals = {};
  for (const p of conn.extra) {
    const key = p.name || p.label;
    const input = $("#paramBox").querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!input) { vals[key] = p.default; continue; }
    if (p.kind === "select") vals[key] = JSON.parse(input.value);
    else if (p.kind === "bool") vals[key] = input.checked;
    else if (p.kind === "number") vals[key] = input.value === "" ? null : Number(input.value);
    else vals[key] = input.value;
  }
  return vals;
}
function saveParamValues() { if (conn) settings.saveParams(conn.space, readParamValues()); }

/* ---------------- separation ---------------- */
let chosenFile = null;
let currentJob = null;
let wakeLock = null;

$("#fileInput").onchange = (e) => {
  chosenFile = e.target.files[0] || null;
  $("#dzText").textContent = chosenFile ? chosenFile.name : "Tap to choose a song";
  $("#dropzone").classList.toggle("has-file", !!chosenFile);
  $("#btnSeparate").disabled = !chosenFile;
  $("#sepError").classList.add("hidden");
};
$("#btnChangeSpace").onclick = () => show("settings");

function setProgress({ title, text, frac }) {
  if (title) $("#progTitle").textContent = title;
  if (text !== undefined) $("#progText").textContent = text;
  const bar = $("#progBar").parentElement;
  if (frac == null) bar.classList.add("indeterminate");
  else { bar.classList.remove("indeterminate"); $("#progBar").style.width = Math.round(frac * 100) + "%"; }
}

$("#btnCancel").onclick = async () => {
  try { await currentJob?.cancel(); } catch {}
  currentJob = null;
  finishUi();
  toast("Cancelled");
};

function finishUi() {
  $("#progress").classList.add("hidden");
  $("#btnSeparate").disabled = !chosenFile;
  clearInterval(finishUi._timer);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

$("#btnSeparate").onclick = async () => {
  if (!chosenFile) return;
  if (!navigator.onLine) return showError("You're offline. Separation needs an internet connection; the library works offline.");
  $("#sepError").classList.add("hidden");
  $("#btnSeparate").disabled = true;
  $("#progress").classList.remove("hidden");
  const started = Date.now();
  let phase = "Connecting to Space…";
  setProgress({ title: phase, text: "", frac: null });
  finishUi._timer = setInterval(() => {
    $("#progTitle").textContent = `${phase} (${fmtTime((Date.now() - started) / 1000)})`;
  }, 1000);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}

  try {
    const c = await connect((msg) => setProgress({ text: msg }));
    renderParams();
    const { handle_file } = await loadGradio();
    const vals = readParamValues();
    saveParamValues();
    const data = new Array(c.info.parameters.length).fill(null);
    data[c.fileIdx] = handle_file(chosenFile);
    for (const p of c.extra) data[p.idx] = vals[p.name || p.label];

    phase = "Uploading & queuing…";
    setProgress({ text: `${chosenFile.name} → ${c.space}`, frac: null });
    const job = c.app.submit(c.endpoint, data);
    currentJob = job;
    let result = null;
    for await (const msg of job) {
      if (currentJob !== job) return; // cancelled
      if (msg.type === "status") {
        if (msg.stage === "error") {
          const m = typeof msg.message === "string" ? msg.message : (msg.message || []).map((v) => v.message).join("; ");
          throw new Error(m || "The Space reported an error (it may be out of GPU quota or overloaded).");
        }
        if (msg.stage === "pending") {
          phase = msg.position != null && msg.position > 0 ? `In queue (#${msg.position + 1})` : "Separating…";
          setProgress({ text: msg.eta ? `Estimated ${Math.round(msg.eta)} s` : "This usually takes 1–5 minutes per song.", frac: null });
        }
        if (msg.progress_data?.[0]) {
          const pd = msg.progress_data[0];
          const frac = pd.progress != null ? (pd.length ? pd.progress / pd.length : pd.progress) : null;
          phase = "Separating…";
          setProgress({ text: pd.desc || "", frac });
        }
        if (msg.stage === "complete") break;
      } else if (msg.type === "data") {
        result = msg.data;
      } else if (msg.type === "log" && msg.log) {
        setProgress({ text: msg.log });
      }
    }
    if (!result) throw new Error("The Space finished but returned nothing.");

    phase = "Downloading stems…";
    setProgress({ text: "", frac: 0 });
    const outputs = collectOutputs(result, c.info.returns);
    if (!outputs.length) throw new Error("No audio came back. This Space may need different options. Check the settings above.");
    const blobs = [];
    for (let i = 0; i < outputs.length; i++) {
      setProgress({ text: outputs[i].name, frac: i / outputs.length });
      blobs.push(await fetchOutput(outputs[i].url));
    }
    setProgress({ text: "Saving to library…", frac: 1 });
    const id = await saveTrack(chosenFile, outputs, blobs, c.space);
    finishUi();
    toast("Done! Saved to your library");
    resetChooser();
    show("library");
    openTrack(id);
  } catch (err) {
    console.error(err);
    finishUi();
    if (currentJob === null && String(err).includes("abort")) return;
    showError(friendlyError(err));
    conn = null; // force reconnect next time
  } finally {
    currentJob = null;
  }
};

function resetChooser() {
  chosenFile = null;
  $("#fileInput").value = "";
  $("#dzText").textContent = "Tap to choose a song";
  $("#dropzone").classList.remove("has-file");
  $("#btnSeparate").disabled = true;
}

function friendlyError(err) {
  const m = String(err?.message || err);
  if (/quota|ZeroGPU|exceeded your GPU/i.test(m))
    return m + "\n\nTip: add a free Hugging Face token in Settings for more GPU time, or use your own Space (see README).";
  if (/could not resolve|not found|404|Could not get API/i.test(m))
    return m + "\n\nThe Space may be paused, deleted, private or crashed. Try another Space in Settings.";
  if (/fetch|network|Failed to fetch|load failed/i.test(m))
    return m + "\n\nA network error. Check your connection, and keep the app in the foreground while it works.";
  return m;
}
function showError(m) { const e = $("#sepError"); e.textContent = m; e.classList.remove("hidden"); }

function collectOutputs(data, returns) {
  const out = [];
  const seen = new Map();
  const add = (item, label) => {
    if (!item || typeof item !== "object" || !item.url) return;
    const base = (item.orig_name || item.path || "").split("/").pop().replace(/\.[^.]+$/, "");
    let name = (label && !/^(output|audio|value_\d+|file)/i.test(label) ? label : base || label || "stem").replace(/_/g, " ").trim();
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name += ` ${n}`;
    out.push({ name, url: item.url, mime: item.mime_type || "" });
  };
  (Array.isArray(data) ? data : [data]).forEach((d, i) => {
    const label = returns?.[i]?.label;
    if (Array.isArray(d)) d.forEach((x) => add(x, null));
    else add(d, label);
  });
  return out;
}

async function fetchOutput(url) {
  let r;
  try { r = await fetch(url); } catch { r = null; }
  if ((!r || !r.ok) && settings.token) r = await fetch(url, { headers: { Authorization: `Bearer ${settings.token}` } });
  if (!r || !r.ok) throw new Error(`Couldn't download a stem (HTTP ${r?.status ?? "network error"})`);
  return r.blob();
}

async function saveTrack(file, outputs, blobs, space) {
  const id = uid();
  const title = file.name.replace(/\.[^.]+$/, "");
  const entries = [];
  const stems = outputs.map((o, i) => {
    const key = `${id}:${i}`;
    entries.push([key, blobs[i]]);
    return { name: o.name, key, size: blobs[i].size, type: blobs[i].type || o.mime || "audio/wav" };
  });
  if (settings.keepOriginal) {
    const key = `${id}:orig`;
    entries.push([key, file]);
    stems.push({ name: "Original mix", key, size: file.size, type: file.type || "audio/mpeg", original: true });
  }
  const track = { id, title, created: Date.now(), space, stems, mixer: {} };
  await db.saveNew(track, entries);
  return id;
}

/* ---------------- library ---------------- */
$("#libSearch").oninput = () => renderLibrary();

async function renderLibrary() {
  const list = $("#libList");
  const q = $("#libSearch").value.trim().toLowerCase();
  let tracks = [];
  try { tracks = await db.allTracks(); } catch (e) { list.textContent = "Storage unavailable: " + e.message; return; }
  tracks.sort((a, b) => b.created - a.created);
  const shown = tracks.filter((t) => !q || t.title.toLowerCase().includes(q));
  list.innerHTML = "";
  $("#libEmpty").classList.toggle("hidden", tracks.length > 0);
  for (const t of shown) {
    const art = el("div", { className: "art" });
    t.stems.filter((s) => !s.original).slice(0, 6).forEach((s, i) => {
      art.append(el("i", { style: `background:${colorFor(s.name)};height:${[70, 100, 55, 85, 65, 90][i]}%` }));
    });
    const chips = el("div", { className: "stems" });
    t.stems.filter((s) => !s.original).forEach((s) => chips.append(el("span", { className: "dot", textContent: s.name })));
    const size = t.stems.reduce((a, s) => a + (s.size || 0), 0);
    const row = el("div", { className: "track" }, art,
      el("div", { className: "info" },
        el("div", { className: "name", textContent: t.title }),
        el("div", { className: "muted small", textContent: `${new Date(t.created).toLocaleDateString()} · ${fmtBytes(size)}` }),
        chips));
    row.onclick = () => openTrack(t.id);
    list.append(row);
  }
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    $("#storageInfo").textContent = `Using ${fmtBytes(usage || 0)} of about ${fmtBytes(quota || 0)} available on this device`;
  }
}

async function openTrack(id) {
  const t = await db.getTrack(id);
  if (!t) return toast("Not found");
  show("player");
  await player.open(t);
}

/* ---------------- multitrack player ---------------- */
const player = {
  ctx: null, track: null, stems: [], playing: false, raf: 0, saveT: 0,

  async open(track) {
    this.close();
    this.track = track;
    $("#plTitle").textContent = track.title;
    $("#plMeta").textContent = `${new Date(track.created).toLocaleString()} · via ${track.space}`;
    const mixer = $("#mixer");
    mixer.innerHTML = "";
    this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (const s of track.stems) {
      const blob = await db.getBlob(s.key);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = url;
      audio.setAttribute("playsinline", "");
      const src = this.ctx.createMediaElementSource(audio);
      const gain = this.ctx.createGain();
      src.connect(gain).connect(this.ctx.destination);
      const saved = track.mixer?.[s.key] || {};
      const st = { meta: s, blob, url, audio, src, gain, vol: saved.vol ?? 1, mute: saved.mute ?? !!s.original, solo: saved.solo ?? false };
      this.stems.push(st);
      mixer.append(this.stemRow(st));
      audio.addEventListener("loadedmetadata", () => this.updateTime());
      audio.addEventListener("ended", () => { if (audio === this.master()) this.onEnded(); });
    }
    $("#rate").value = "1";
    this.applyGains();
    this.updateTime();
  },

  master() {
    // the longest track drives the clock
    return this.stems.reduce((a, s) => (!a || (s.audio.duration || 0) > (a.audio.duration || 0) ? s : a), null)?.audio;
  },

  stemRow(st) {
    const c = colorFor(st.meta.name);
    const m = el("button", { className: "tbtn", textContent: "M", title: "Mute" });
    const s = el("button", { className: "tbtn", textContent: "S", title: "Solo" });
    const save = el("button", { className: "tbtn", textContent: "⤓", title: "Save / share this stem" });
    const vol = el("input", { type: "range", min: 0, max: 1.5, step: 0.01, value: st.vol });
    const row = el("div", { className: "stem", style: `--c:${c}` },
      el("div", { className: "top" }, el("div", { className: "sname", textContent: st.meta.name }), m, s, save), vol);
    st.row = row; st.mBtn = m; st.sBtn = s;
    m.onclick = () => { st.mute = !st.mute; this.applyGains(); };
    s.onclick = () => { st.solo = !st.solo; this.applyGains(); };
    vol.oninput = () => { st.vol = Number(vol.value); this.applyGains(); };
    save.onclick = () => shareBlob(st.blob, `${this.track.title} - ${st.meta.name}${extFor(st.blob)}`);
    return row;
  },

  audible(st) {
    const anySolo = this.stems.some((x) => x.solo);
    return anySolo ? st.solo : !st.mute;
  },

  applyGains() {
    for (const st of this.stems) {
      const on = this.audible(st);
      st.gain.gain.setTargetAtTime(on ? st.vol : 0, this.ctx.currentTime, 0.015);
      st.row.classList.toggle("off", !on);
      st.mBtn.classList.toggle("on-m", st.mute);
      st.sBtn.classList.toggle("on-s", st.solo);
    }
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.persistMixer(), 600);
  },

  async persistMixer() {
    if (!this.track) return;
    this.track.mixer = Object.fromEntries(this.stems.map((s) => [s.meta.key, { vol: s.vol, mute: s.mute, solo: s.solo }]));
    try { await db.putTrack(this.track); } catch {}
  },

  async play() {
    if (!this.stems.length) return;
    await this.ctx.resume();
    const t = this.master().currentTime;
    const rate = Number($("#rate").value);
    this.stems.forEach((s) => { s.audio.currentTime = t; s.audio.playbackRate = rate; s.audio.preservesPitch = true; });
    await Promise.all(this.stems.map((s) => s.audio.play().catch(() => {})));
    this.playing = true;
    $("#btnPlay").textContent = "❚❚";
    this.loop();
  },

  pause() {
    this.stems.forEach((s) => s.audio.pause());
    this.playing = false;
    $("#btnPlay").textContent = "▶";
    cancelAnimationFrame(this.raf);
  },

  seek(t) {
    const d = this.master()?.duration || 0;
    t = Math.max(0, Math.min(d, t));
    this.stems.forEach((s) => (s.audio.currentTime = Math.min(t, s.audio.duration || t)));
    this.updateTime();
  },

  loop() {
    cancelAnimationFrame(this.raf);
    let last = 0;
    const tick = (now) => {
      if (!this.playing) return;
      this.updateTime();
      if (now - last > 400) { // drift correction
        last = now;
        const mt = this.master().currentTime;
        for (const s of this.stems) {
          if (s.audio.ended || s.audio.currentTime >= (s.audio.duration || 0) - 0.05) continue;
          if (Math.abs(s.audio.currentTime - mt) > 0.07) s.audio.currentTime = mt;
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  onEnded() {
    if ($("#loop").checked) { this.seek(0); this.play(); }
    else { this.pause(); this.seek(0); }
  },

  updateTime() {
    const m = this.master();
    if (!m) return;
    const d = m.duration || 0;
    $("#tCur").textContent = fmtTime(m.currentTime);
    $("#tDur").textContent = fmtTime(d);
    if (!this.dragging) $("#seek").value = d ? Math.round((m.currentTime / d) * 1000) : 0;
  },

  close() {
    if (!this.stems.length) return;
    this.pause();
    this.persistMixer();
    for (const s of this.stems) {
      s.audio.removeAttribute("src");
      s.audio.load();
      try { s.src.disconnect(); s.gain.disconnect(); } catch {}
      URL.revokeObjectURL(s.url);
    }
    this.stems = [];
  },

  async exportMix() {
    const active = this.stems.filter((s) => this.audible(s) && s.vol > 0);
    if (!active.length) return toast("Everything is muted");
    toast("Rendering mix… this may take a moment", 6000);
    const decoded = [];
    for (const s of active) decoded.push([s, await this.ctx.decodeAudioData(await s.blob.arrayBuffer())]);
    const sr = decoded[0][1].sampleRate;
    const len = Math.max(...decoded.map(([, b]) => Math.ceil(b.duration * sr)));
    const off = new OfflineAudioContext(2, len, sr);
    for (const [s, buf] of decoded) {
      const src = off.createBufferSource();
      src.buffer = buf;
      const g = off.createGain();
      g.gain.value = s.vol;
      src.connect(g).connect(off.destination);
      src.start(0);
    }
    const rendered = await off.startRendering();
    const label = active.length === this.stems.length ? "full mix" : active.map((s) => s.meta.name).join("+");
    await shareBlob(encodeWav(rendered), `${this.track.title} (${label}).wav`);
  },
};

$("#btnPlay").onclick = () => (player.playing ? player.pause() : player.play());
$("#btnRew").onclick = () => player.seek((player.master()?.currentTime || 0) - 10);
$("#btnFwd").onclick = () => player.seek((player.master()?.currentTime || 0) + 10);
$("#rate").onchange = () => player.stems.forEach((s) => (s.audio.playbackRate = Number($("#rate").value)));
const seekEl = $("#seek");
seekEl.oninput = () => { player.dragging = true; const d = player.master()?.duration || 0; $("#tCur").textContent = fmtTime((seekEl.value / 1000) * d); };
seekEl.onchange = () => { player.dragging = false; const d = player.master()?.duration || 0; player.seek((seekEl.value / 1000) * d); };
$("#btnBack").onclick = () => show("library");
$("#btnExportMix").onclick = () => player.exportMix().catch((e) => toast("Export failed: " + e.message, 5000));
$("#btnRename").onclick = async () => {
  const t = player.track;
  const name = prompt("New name", t.title);
  if (!name) return;
  t.title = name.trim();
  $("#plTitle").textContent = t.title;
  await db.putTrack(t);
};
$("#btnDelete").onclick = async () => {
  const t = player.track;
  if (!confirm(`Delete "${t.title}" and all its stems from this phone?`)) return;
  player.close();
  await db.deleteTrack(t);
  toast("Deleted");
  show("library");
};

function extFor(blob) {
  const t = blob.type || "";
  if (/mpeg|mp3/.test(t)) return ".mp3";
  if (/flac/.test(t)) return ".flac";
  if (/ogg/.test(t)) return ".ogg";
  if (/mp4|m4a|aac/.test(t)) return ".m4a";
  return ".wav";
}

async function shareBlob(blob, filename) {
  filename = filename.replace(/[\\/:*?"<>|]/g, "_");
  const file = new File([blob], filename, { type: blob.type || "audio/wav" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = el("a", { href: URL.createObjectURL(file), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function encodeWav(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    o += 2;
  }
  return new Blob([out], { type: "audio/wav" });
}

/* ---------------- settings view ---------------- */
function fillSettings() {
  $("#spaceInput").value = settings.space;
  $("#tokenInput").value = settings.token;
  $("#keepOriginal").checked = settings.keepOriginal;
  const box = $("#spaceSuggestions");
  box.innerHTML = "";
  for (const s of SUGGESTED_SPACES) {
    const chip = el("button", { className: "chip" }, s.id + " ", el("small", { textContent: s.note }));
    chip.onclick = () => ($("#spaceInput").value = s.id);
    box.append(chip);
  }
}

$("#btnSaveSettings").onclick = async () => {
  let space = $("#spaceInput").value.trim();
  // accept full URLs: https://huggingface.co/spaces/owner/name or https://owner-name.hf.space
  const m = space.match(/huggingface\.co\/spaces\/([^/]+\/[^/?#]+)/);
  if (m) space = m[1];
  if (!space) return;
  settings.space = space;
  settings.token = $("#tokenInput").value.trim();
  settings.keepOriginal = $("#keepOriginal").checked;
  conn = null;
  const msg = $("#settingsMsg");
  msg.style.color = "";
  msg.textContent = "Connecting…";
  try {
    const c = await connect((s) => (msg.textContent = s));
    const outs = c.info.returns.map((r) => r.label).filter(Boolean).join(", ");
    msg.style.color = "var(--ok)";
    msg.textContent = `✓ Connected. Using ${c.endpoint}${outs ? ` → ${outs}` : ""}`;
    renderParams();
  } catch (e) {
    msg.style.color = "var(--danger)";
    msg.textContent = "✗ " + friendlyError(e);
  }
};

$("#btnWipe").onclick = async () => {
  if (!confirm("Delete ALL songs and stems from this phone? This can't be undone.")) return;
  await db.wipe();
  toast("Library cleared");
};

/* ---------------- PWA plumbing ---------------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e;
  $("#btnInstall").classList.remove("hidden");
});
$("#btnInstall").onclick = async () => { if (!installEvt) return; installEvt.prompt(); installEvt = null; $("#btnInstall").classList.add("hidden"); };

const updateNet = () => $("#netBadge").classList.toggle("hidden", navigator.onLine);
addEventListener("online", updateNet);
addEventListener("offline", updateNet);
updateNet();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
navigator.storage?.persist?.().catch(() => {});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && currentJob && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});

renderParams();
// Warm up the connection in the background so options (model choice etc.) appear.
if (navigator.onLine) connect().then(renderParams).catch(() => {});
