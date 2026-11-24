// StemSplit: a phone-friendly front end for Hugging Face stem-separation Spaces,
// with a local library (IndexedDB) and a multitrack stem mixer.

import * as fflate from "./vendor/fflate.js";

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
  get compress() { return localStorage.getItem("ss.compress") !== "0"; },
  set compress(v) { localStorage.setItem("ss.compress", v ? "1" : "0"); },
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
  if (chosenFile && !isAudio(chosenFile)) { toast("That doesn't look like an audio file"); chosenFile = null; e.target.value = ""; }
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
    const stems = outputs.map((o, i) => ({ name: o.name, blob: blobs[i] }));
    if (settings.keepOriginal) stems.push({ name: "Original mix", blob: chosenFile, original: true });
    if (settings.compress) {
      phase = "Shrinking to MP3…";
      await compressStems(stems, (name, k, n, f) => setProgress({ text: `${name} (${k + 1}/${n})`, frac: (k + f) / n }));
    }
    phase = "Saving…";
    setProgress({ text: "Saving to library…", frac: 1 });
    const id = await createTrack({ title: chosenFile.name.replace(/\.[^.]+$/, ""), space: c.space, stems });
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

/* ---------------- multitrack player + practice tools ---------------- */
const PEAKS_PER_SEC = 200;              // waveform resolution: 5 ms per bin
const ZOOMS = [1, 2, 5, 10];            // seconds visible in the fine-tune view
const MIN_LOOP = 0.05;
const COL_A = "#ffcf5a", COL_B = "#ff7a59";

// m:ss.d (tenths) for the playhead, m:ss.cc (hundredths) for loop points
function fmtT(s, d = 1) {
  if (!isFinite(s) || s < 0) s = 0;
  const f = 10 ** d;
  const v = Math.floor(s * f + 1e-6) / f;
  const m = Math.floor(v / 60);
  return `${m}:${(v - m * 60).toFixed(d).padStart(d ? d + 3 : 2, "0")}`;
}
// accepts 1:23.45 · 83.45 · 1.23.45 (phone decimal keypad has no colon)
function parseTime(str) {
  str = String(str).trim().replace(/,/g, ".").replace(/\s+/g, "");
  if (!str) return null;
  let t;
  if (str.includes(":")) {
    const parts = str.split(":").map(Number);
    t = parts.reduce((acc, v) => acc * 60 + v, 0);
  } else {
    const p = str.split(".");
    t = p.length === 3 ? Number(p[0]) * 60 + Number(p[1] + "." + p[2]) : Number(str);
  }
  return isFinite(t) && t >= 0 ? t : null;
}
function prepCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
// time signature → beats the BPM counts per bar (x/8 metres count dotted quarters, as musicians usually do)
const METERS = { "2/4": 2, "3/4": 3, "4/4": 4, "5/4": 5, "6/4": 6, "7/4": 7, "6/8": 2, "12/8": 4 };
const meterOf = (p) => (p.meter && METERS[p.meter] ? p.meter : `${p.bpb || 4}/4` in METERS ? `${p.bpb || 4}/4` : "4/4");
const PRACTICE_DEFAULTS = {
  rate: 1, loopOn: false, a: 0, b: null, active: "a", zoomIdx: 1,
  bars: 4, bpb: 4, bpm: null, sections: [], waveKey: null,
};

const player = {
  ctx: null, track: null, stems: [], playing: false, raf: 0, saveT: 0,
  p: { ...PRACTICE_DEFAULTS }, peaks: null, ovCache: null, stopAt: null, returnTo: null,

  async open(track) {
    this.close();
    this.track = track;
    this.p = { ...PRACTICE_DEFAULTS, ...(track.practice || {}) };
    this.p.sections = [...(this.p.sections || [])];
    this.p.meter = meterOf(this.p);
    this.p.bpb = METERS[this.p.meter];
    this.peaks = null; this.ovCache = null; this.stopAt = null;
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
      audio.addEventListener("loadedmetadata", () => { this.refresh(); });
      audio.addEventListener("ended", () => { if (audio === this.master()) this.onEnded(); });
    }
    // waveform source picker: drums are best for finding the start of a bar
    const sel = $("#waveSrc");
    sel.innerHTML = "";
    for (const st of this.stems) sel.append(el("option", { value: st.meta.key, textContent: st.meta.name }));
    const pick = this.stems.find((s) => s.meta.key === this.p.waveKey) ||
      this.stems.find((s) => /drum|perc/i.test(s.meta.name)) ||
      this.stems.find((s) => s.meta.original) || this.stems[0];
    if (pick) { sel.value = pick.meta.key; this.loadPeaks(pick.meta.key); }
    this.setRate(this.p.rate, false);
    this.applyGains(false);
    this.setupMediaSession();
    $("#btnShrink").classList.toggle("hidden", !looksUncompressed(track));
    this.refresh();
  },

  /* ---- clock helpers ---- */
  master() {
    return this.stems.reduce((a, s) => (!a || (s.audio.duration || 0) > (a.audio.duration || 0) ? s : a), null)?.audio;
  },
  dur() { return this.master()?.duration || 0; },
  now() { return this.master()?.currentTime || 0; },
  A() { return Math.min(this.p.a || 0, Math.max(0, this.B() - MIN_LOOP)); },
  B() { const d = this.dur(); return this.p.b == null ? d : Math.min(this.p.b, d || this.p.b); },
  bpmLen() { return (this.p.bars * this.p.bpb * 60) / this.p.bpm; },

  /* ---- mixer rows ---- */
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
  applyGains(save = true) {
    for (const st of this.stems) {
      const on = this.audible(st);
      st.gain.gain.setTargetAtTime(on ? st.vol : 0, this.ctx.currentTime, 0.015);
      st.row.classList.toggle("off", !on);
      st.mBtn.classList.toggle("on-m", st.mute);
      st.sBtn.classList.toggle("on-s", st.solo);
    }
    if (save) this.persistSoon();
  },

  /* ---- persistence ---- */
  persistSoon() { clearTimeout(this.saveT); this.saveT = setTimeout(() => this.persist(), 500); },
  async persist() {
    if (!this.track) return;
    this.track.mixer = Object.fromEntries(this.stems.map((s) => [s.meta.key, { vol: s.vol, mute: s.mute, solo: s.solo }]));
    this.track.practice = { ...this.p };
    try { await db.putTrack(this.track); } catch {}
  },

  /* ---- transport ---- */
  async play(fromAudition = false) {
    if (!this.stems.length) return;
    await this.ctx.resume();
    if (!fromAudition) {
      this.stopAt = null;
      const t = this.now();
      if (this.p.loopOn && (t < this.A() - 0.01 || t >= this.B() - 0.02)) this.seek(this.A());
    }
    const t = this.now();
    this.stems.forEach((s) => { s.audio.currentTime = t; s.audio.playbackRate = this.p.rate; s.audio.preservesPitch = true; s.audio.webkitPreservesPitch = true; });
    await Promise.all(this.stems.map((s) => s.audio.play().catch(() => {})));
    this.playing = true;
    $("#btnPlay").textContent = "❚❚";
    if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
    this.loop();
  },
  pause() {
    this.stems.forEach((s) => s.audio.pause());
    this.playing = false;
    $("#btnPlay").textContent = "▶";
    if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
    cancelAnimationFrame(this.raf);
    this.refresh();
  },
  seek(t) {
    const d = this.dur();
    t = Math.max(0, Math.min(d || t, t));
    this.stems.forEach((s) => (s.audio.currentTime = Math.min(t, s.audio.duration || t)));
    this.refresh();
  },
  loop() {
    cancelAnimationFrame(this.raf);
    let lastSync = 0;
    const tick = (now) => {
      if (!this.playing) return;
      const mt = this.now();
      if (this.stopAt != null) {
        if (mt >= this.stopAt) {
          const back = this.returnTo;
          this.stopAt = null;
          this.pause();
          if (back != null) this.seek(back);
          return;
        }
      } else if (this.p.loopOn) {
        const B = this.B();
        // jump a hair early so the restart lands on A as cleanly as media elements allow
        if (mt >= B - 0.012 * this.p.rate && B < this.dur() - 0.02) { this.seek(this.A()); lastSync = now; }
      }
      if (now - lastSync > 400) { // keep stems in sync
        lastSync = now;
        for (const s of this.stems) {
          if (s.audio.ended || s.audio.currentTime >= (s.audio.duration || 0) - 0.05) continue;
          if (Math.abs(s.audio.currentTime - mt) > 0.07) s.audio.currentTime = mt;
        }
      }
      this.refresh(true);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  onEnded() {
    if (this.stopAt != null) { this.stopAt = null; this.pause(); if (this.returnTo != null) this.seek(this.returnTo); return; }
    if (this.p.loopOn) { this.seek(this.A()); this.play(); }
    else { this.pause(); this.seek(0); }
  },
  // short preview around the selected point: plays into A, or up to B
  audition() {
    const r = this.p.rate, span = 1.5 * r;
    const isA = this.p.active === "a";
    const from = isA ? this.A() : Math.max(0, this.B() - span);
    const to = isA ? Math.min(this.dur(), this.A() + span) : this.B();
    this.pause();
    this.seek(from);
    this.returnTo = from;
    this.stopAt = to;
    this.play(true);
  },
  setRate(r, save = true) {
    r = Math.round(Math.max(0.5, Math.min(1.5, r)) * 20) / 20;
    this.p.rate = r;
    this.stems.forEach((s) => (s.audio.playbackRate = r));
    $("#rate").value = r;
    $("#spdVal").textContent = Math.round(r * 100) + "%";
    if (save) this.persistSoon();
  },
  toggleLoop(on = !this.p.loopOn) {
    this.p.loopOn = on;
    this.refresh();
    this.persistSoon();
  },

  /* ---- loop points ---- */
  setActive(which) {
    this.p.active = which;
    this.refresh();
  },
  // jump the playhead to a loop point; for B while looping, land 2 s before it so you hear B arrive
  jumpTo(which) {
    this.setActive(which);
    if (which === "a") this.seek(this.A());
    else this.seek(this.p.loopOn ? Math.max(this.A(), this.B() - 2 * this.p.rate) : this.B());
  },
  setPoint(which, t, { keepLock = false } = {}) {
    const d = this.dur();
    if (!d) return;
    t = Math.max(0, Math.min(d, t));
    if (which === "a") {
      if (this.p.bpm) { // tempo locked: keep the exact bar length, B follows A
        const len = this.bpmLen();
        t = Math.min(t, Math.max(0, d - len));
        this.p.a = t; this.p.b = Math.min(d, t + len);
      } else if (t > this.B() - MIN_LOOP) {
        // A set past B: A goes exactly there, B is released to the end of the song
        this.p.a = Math.min(t, d - MIN_LOOP);
        this.p.b = null;
      } else {
        this.p.a = t;
      }
    } else {
      if (!keepLock) this.p.bpm = null;
      if (t < this.A() + MIN_LOOP) {
        // B set before A: B goes exactly there, A is released to the start of the song
        t = Math.max(t, MIN_LOOP);
        this.p.a = 0;
      }
      this.p.b = t >= d - 0.001 ? null : t;
    }
    this.refresh();
    this.persistSoon();
  },
  setHere(which) {
    this.setActive(which);
    this.setPoint(which, this.now());
    if (which === "b") {
      this.p.loopOn = true; // tap A … tap B → it starts looping right away
      if (this.playing) this.seek(this.A());
      this.refresh();
    }
  },
  nudge(delta) { const w = this.p.active; this.setPoint(w, (w === "a" ? this.A() : this.B()) + delta); },
  setBars(n) {
    this.p.bars = Math.max(1, Math.min(64, n));
    if (this.p.bpm) this.p.b = Math.min(this.dur(), this.A() + this.bpmLen());
    this.refresh(); this.persistSoon();
  },
  setBpm(bpm) {
    if (!bpm || bpm < 20 || bpm > 400) { this.p.bpm = null; this.refresh(); return; }
    this.p.bpm = bpm;
    const d = this.dur();
    if (this.A() + this.bpmLen() > d) this.p.a = Math.max(0, d - this.bpmLen());
    this.p.b = Math.min(d, this.A() + this.bpmLen());
    this.refresh(); this.persistSoon();
  },
  shiftSection(dir) {
    const a = this.A(), len = this.B() - a, d = this.dur();
    const na = a + dir * len;
    if (na < -0.001 || na + len > d + 0.001) return toast(dir < 0 ? "Already at the start" : "Already at the end");
    this.p.a = Math.max(0, na); this.p.b = Math.min(d, na + len);
    if (this.p.b >= d - 0.001) this.p.b = null;
    this.p.loopOn = true;
    this.seek(this.A());
    this.persistSoon();
  },
  resetLoop() {
    Object.assign(this.p, { a: 0, b: null, bpm: null, loopOn: false, active: "a" });
    this.refresh(); this.persistSoon();
  },
  saveSection() {
    const name = prompt("Name this section", `Section ${this.p.sections.length + 1}`);
    if (!name) return;
    this.p.sections.push({ name: name.trim(), a: this.A(), b: this.B(), bars: this.p.bars, bpb: this.p.bpb, meter: this.p.meter, bpm: this.p.bpm });
    this.refresh(); this.persistSoon();
  },
  loadSection(i) {
    const s = this.p.sections[i];
    Object.assign(this.p, { a: s.a, b: s.b, bars: s.bars ?? this.p.bars, bpb: s.bpb ?? this.p.bpb, bpm: s.bpm ?? null, loopOn: true });
    this.p.meter = meterOf({ meter: s.meter, bpb: this.p.bpb });
    this.p.bpb = METERS[this.p.meter];
    this.seek(this.A());
    this.persistSoon();
  },

  /* ---- UI refresh ---- */
  refresh(fast = false) {
    const d = this.dur(), t = this.now();
    $("#tCur").textContent = fmtT(t, 1);
    $("#tDur").textContent = fmtT(d, 1);
    this.drawOverview();
    this.drawZoom();
    if (fast) return;
    const A = this.A(), B = this.B(), len = B - A;
    $("#btnLoop").setAttribute("aria-pressed", String(this.p.loopOn));
    $("#ptA").classList.toggle("active", this.p.active === "a");
    $("#ptB").classList.toggle("active", this.p.active === "b");
    if (!$("#tA").hidden) $("#tA").textContent = fmtT(A, 2);
    if (!$("#tB").hidden) $("#tB").textContent = this.p.b == null ? `end ${fmtT(d, 1)}` : fmtT(B, 2);
    $("#zoomPt").textContent = this.p.active.toUpperCase();
    $("#btnZoom").textContent = `${ZOOMS[this.p.zoomIdx]} s view`;
    $("#loopLen").textContent = d ? `${len.toFixed(2)} s${this.p.loopOn ? " · looping" : ""}` : "";
    $("#barsVal").textContent = `${this.p.bars} bar${this.p.bars > 1 ? "s" : ""}`;
    $("#bpb").value = this.p.meter;
    const implied = len > 0 ? (this.p.bars * this.p.bpb * 60) / len : 0;
    if (document.activeElement !== $("#bpm")) $("#bpm").value = this.p.bpm ? String(+this.p.bpm.toFixed(2)) : implied ? implied.toFixed(1) : "";
    $("#bpmLock").setAttribute("aria-pressed", String(!!this.p.bpm));
    $("#bpmLock").textContent = this.p.bpm ? "🔒" : "🔓";
    $("#bpmLock").title = this.p.bpm ? "Tempo locked: B stays exactly the chosen bars after A. Tap to unlock." : "BPM is worked out from the loop. Type a BPM or tap to lock it.";
    const box = $("#sections");
    box.innerHTML = "";
    this.p.sections.forEach((s, i) => {
      const on = Math.abs(s.a - A) < 0.005 && Math.abs(s.b - B) < 0.005;
      const x = el("span", { className: "x", textContent: "×", title: "Remove section" });
      const card = el("button", { className: "sec" + (on ? " on" : "") },
        el("span", { className: "nm" }, el("b", { textContent: s.name }), el("small", { textContent: `${fmtT(s.a, 1)} – ${fmtT(s.b, 1)}` })), x);
      card.onclick = (e) => {
        if (e.target === x) { if (confirm(`Remove section "${s.name}"?`)) { this.p.sections.splice(i, 1); this.refresh(); this.persistSoon(); } return; }
        this.loadSection(i);
      };
      box.append(card);
    });
  },

  /* ---- waveform ---- */
  async loadPeaks(key) {
    const st = this.stems.find((s) => s.meta.key === key);
    if (!st) return;
    this.p.waveKey = key;
    const track = this.track;
    track.peaks ||= {};
    let pk = track.peaks[key];
    if (!pk) {
      try {
        const buf = await this.ctx.decodeAudioData(await st.blob.arrayBuffer());
        const n = Math.ceil(buf.duration * PEAKS_PER_SEC), hop = buf.sampleRate / PEAKS_PER_SEC;
        pk = new Float32Array(n);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const data = buf.getChannelData(c);
          for (let i = 0; i < n; i++) {
            let m = pk[i];
            const end = Math.min(data.length, Math.floor((i + 1) * hop));
            for (let j = Math.floor(i * hop); j < end; j++) { const v = data[j] < 0 ? -data[j] : data[j]; if (v > m) m = v; }
            pk[i] = m;
          }
        }
        let max = 0;
        for (const v of pk) if (v > max) max = v;
        if (max > 0) for (let i = 0; i < n; i++) pk[i] = Math.pow(pk[i] / max, 0.7);
        track.peaks[key] = pk;
        this.persistSoon();
      } catch (e) { console.warn("waveform failed", e); return; }
    }
    if (this.track !== track || this.p.waveKey !== key) return;
    this.peaks = pk; this.ovCache = null;
    this.refresh();
  },
  peakAt(i0, i1) {
    const pk = this.peaks;
    if (!pk) return 0;
    i0 = Math.max(0, Math.floor(i0)); i1 = Math.min(pk.length, Math.max(i0 + 1, Math.ceil(i1)));
    let m = 0;
    for (let i = i0; i < i1; i++) if (pk[i] > m) m = pk[i];
    return m;
  },
  drawOverview() {
    const c = $("#overview");
    if (!c.clientWidth) return;
    const { g, w, h } = prepCanvas(c);
    const d = this.dur();
    g.clearRect(0, 0, w, h);
    const x = (t) => (d ? (t / d) * w : 0);
    // cached waveform columns
    if (!this.ovCache || this.ovCache.w !== w || this.ovCache.peaks !== this.peaks || this.ovCache.d !== d) {
      const cols = new Float32Array(Math.ceil(w));
      if (this.peaks && d) for (let px = 0; px < w; px++) cols[px] = this.peakAt((px / w) * d * PEAKS_PER_SEC, ((px + 1) / w) * d * PEAKS_PER_SEC);
      this.ovCache = { w, d, peaks: this.peaks, cols };
    }
    const cols = this.ovCache.cols, mid = h / 2 + 6, amp = (h - 16) / 2;
    const A = this.A(), B = this.B(), xa = x(A), xb = x(B), xp = x(this.now());
    if (d) { g.fillStyle = this.p.loopOn ? "rgba(124,156,255,.22)" : "rgba(124,156,255,.10)"; g.fillRect(xa, 12, xb - xa, h - 12); }
    for (let px = 0; px < w; px++) {
      const v = this.peaks ? Math.max(0.02, cols[px]) : 0.02;
      g.fillStyle = px < xp ? "#7c9cff" : "#4a5162";
      g.fillRect(px, mid - v * amp, 1, Math.max(1, v * amp * 2));
    }
    const handle = (xx, col, label, alignRight) => {
      g.fillStyle = col;
      g.fillRect(Math.round(xx) - 1, 10, 2, h - 10);
      const bw = 16, bx = alignRight ? xx - bw : xx;
      g.beginPath(); g.roundRect ? g.roundRect(Math.max(0, Math.min(w - bw, bx)), 0, bw, 14, 4) : g.rect(bx, 0, bw, 14); g.fill();
      g.fillStyle = "#1a1a1a"; g.font = "bold 10px -apple-system, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(label, Math.max(0, Math.min(w - bw, bx)) + bw / 2, 7.5);
    };
    if (d) { handle(xa, COL_A, "A", false); handle(xb, COL_B, "B", true); }
    g.fillStyle = "#fff";
    g.fillRect(Math.round(xp) - 1, 12, 2, h - 12);
  },
  drawZoom() {
    const c = $("#zoom");
    if (!c.clientWidth) return;
    const { g, w, h } = prepCanvas(c);
    g.clearRect(0, 0, w, h);
    const d = this.dur();
    if (!d) return;
    const W = ZOOMS[this.p.zoomIdx];
    const isA = this.p.active === "a";
    const center = isA ? this.A() : this.B();
    const left = center - W / 2;
    const x = (t) => ((t - left) / W) * w;
    const A = this.A(), B = this.B();
    // loop region
    const ra = Math.max(0, x(A)), rb = Math.min(w, x(B));
    if (rb > ra) { g.fillStyle = "rgba(124,156,255,.14)"; g.fillRect(ra, 0, rb - ra, h); }
    // outside the song
    g.fillStyle = "rgba(0,0,0,.35)";
    if (x(0) > 0) g.fillRect(0, 0, x(0), h);
    if (x(d) < w) g.fillRect(x(d), 0, w - x(d), h);
    // ticks: every 0.1 s small, every 1 s tall with time label
    const step = W <= 2 ? 0.1 : W <= 5 ? 0.5 : 1;
    g.font = "10px -apple-system, sans-serif"; g.textBaseline = "top"; g.textAlign = "left";
    for (let t = Math.ceil(left / step) * step; t < left + W; t += step) {
      if (t < 0 || t > d) continue;
      const whole = Math.abs(t - Math.round(t)) < 1e-6;
      g.fillStyle = whole ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.14)";
      const xx = Math.round(x(t));
      g.fillRect(xx, h - (whole ? 14 : 7), 1, whole ? 14 : 7);
      if (whole) { g.fillStyle = "rgba(255,255,255,.5)"; g.fillText(fmtT(t, 0), xx + 3, 2); }
    }
    // waveform
    const mid = h / 2, amp = h / 2 - 14;
    const binsPerPx = (W * PEAKS_PER_SEC) / w;
    g.fillStyle = "#8f9bb8";
    for (let px = 0; px < w; px++) {
      const t = left + (px / w) * W;
      if (t < 0 || t > d || !this.peaks) continue;
      const v = Math.max(0.015, this.peakAt(t * PEAKS_PER_SEC, t * PEAKS_PER_SEC + binsPerPx));
      g.fillRect(px, mid - v * amp, 1, Math.max(1, v * amp * 2));
    }
    if (!this.peaks) { g.fillStyle = "rgba(255,255,255,.4)"; g.textAlign = "center"; g.fillText("drawing waveform…", w / 2, mid - 5); }
    // the other point, playhead, then the active point on top
    const other = isA ? B : A;
    if (x(other) >= 0 && x(other) <= w) { g.fillStyle = isA ? COL_B : COL_A; g.fillRect(Math.round(x(other)) - 1, 0, 2, h); }
    const xp = x(this.now());
    if (xp >= 0 && xp <= w) { g.fillStyle = "#fff"; g.fillRect(Math.round(xp), 0, 1, h); }
    const col = isA ? COL_A : COL_B;
    g.fillStyle = col;
    g.fillRect(Math.round(w / 2) - 1, 0, 3, h);
    g.beginPath(); g.moveTo(w / 2 - 7, 0); g.lineTo(w / 2 + 8, 0); g.lineTo(w / 2 + 0.5, 9); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(w / 2 - 7, h); g.lineTo(w / 2 + 8, h); g.lineTo(w / 2 + 0.5, h - 9); g.closePath(); g.fill();
  },

  /* ---- lock screen / headphone controls ---- */
  setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = new MediaMetadata({ title: this.track.title, artist: "StemSplit", artwork: [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }] });
      ms.setActionHandler("play", () => this.play());
      ms.setActionHandler("pause", () => this.pause());
      ms.setActionHandler("seekbackward", () => this.seek(this.now() - 5));
      ms.setActionHandler("seekforward", () => this.seek(this.now() + 5));
      ms.setActionHandler("previoustrack", () => this.seek(this.A()));
    } catch {}
  },

  close() {
    if (!this.stems.length) return;
    this.pause();
    this.persist();
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
    await offerFile(encodeWav(rendered), `${this.track.title} (${label}).wav`, "Mix ready");
  },
};

/* ---- transport wiring ---- */
$("#btnPlay").onclick = () => (player.playing ? player.pause() : player.play());
$("#btnRew").onclick = () => player.seek(player.now() - 5);
$("#btnFwd").onclick = () => player.seek(player.now() + 5);
$("#btnToA").onclick = () => player.seek(player.p.loopOn || player.p.a ? player.A() : 0);
$("#btnLoop").onclick = () => player.toggleLoop();
$("#rate").oninput = () => player.setRate(Number($("#rate").value));
$("#spdMinus").onclick = () => player.setRate(player.p.rate - 0.05);
$("#spdPlus").onclick = () => player.setRate(player.p.rate + 0.05);
$("#spdVal").onclick = () => player.setRate(1);

/* ---- loop wiring ---- */
$("#setA").onclick = (e) => { e.stopPropagation(); player.setHere("a"); };
$("#setB").onclick = (e) => { e.stopPropagation(); player.setHere("b"); };
$("#ptA").onclick = () => player.jumpTo("a");
$("#ptB").onclick = () => player.jumpTo("b");
document.querySelectorAll(".nudge [data-n]").forEach((b) => (b.onclick = () => player.nudge(Number(b.dataset.n))));
$("#btnAudition").onclick = () => player.audition();
$("#btnZoom").onclick = () => { player.p.zoomIdx = (player.p.zoomIdx + 1) % ZOOMS.length; player.refresh(); player.persistSoon(); };
$("#barsMinus").onclick = () => player.setBars(player.p.bars - 1);
$("#barsPlus").onclick = () => player.setBars(player.p.bars + 1);
$("#bpb").onchange = () => { player.p.meter = $("#bpb").value; player.p.bpb = METERS[player.p.meter]; player.setBars(player.p.bars); };
$("#bpm").onchange = () => player.setBpm(Number($("#bpm").value.replace(",", ".")));
$("#bpm").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
$("#bpmLock").onclick = () => {
  if (player.p.bpm) { player.p.bpm = null; player.refresh(); player.persistSoon(); }
  else player.setBpm(Number($("#bpm").value.replace(",", ".")));
};
$("#btnSaveSection").onclick = () => player.saveSection();
$("#btnClearLoop").onclick = () => player.resetLoop();
$("#waveSrc").onchange = () => { player.peaks = null; player.loadPeaks($("#waveSrc").value); player.refresh(); };

// tap a loop time to type an exact timestamp
for (const which of ["a", "b"]) {
  const btn = $(which === "a" ? "#tA" : "#tB");
  btn.onclick = (e) => {
    e.stopPropagation();
    player.jumpTo(which);
    const inp = el("input", { className: "input num", value: fmtT(which === "a" ? player.A() : player.B(), 2), placeholder: "1:23.45" });
    inp.setAttribute("inputmode", "decimal");
    inp.setAttribute("enterkeyhint", "done");
    btn.hidden = true;
    btn.after(inp);
    inp.focus(); inp.select();
    let done = false;
    const commit = (save) => {
      if (done) return; done = true;
      const t = save ? parseTime(inp.value) : null;
      inp.remove(); btn.hidden = false;
      if (t != null) player.setPoint(which, t);
      else { if (save) toast("Use a time like 1:23.45 (or 1.23.45)"); player.refresh(); }
    };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") commit(true); if (ev.key === "Escape") commit(false); };
    inp.onblur = () => commit(true);
    inp.onclick = (ev) => ev.stopPropagation();
  };
}

// overview: tap to jump, drag the A/B flags to move them
(() => {
  const c = $("#overview");
  let mode = null, lastSeek = 0;
  const tAt = (e) => { const r = c.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * player.dur(); };
  c.addEventListener("pointerdown", (e) => {
    const d = player.dur(); if (!d) return;
    c.setPointerCapture(e.pointerId);
    const r = c.getBoundingClientRect(), xx = e.clientX - r.left;
    const xa = (player.A() / d) * r.width, xb = (player.B() / d) * r.width;
    const da = Math.abs(xx - xa), dbb = Math.abs(xx - xb), near = 22;
    const inFlagRow = e.clientY - r.top < 26;
    if ((da < near || dbb < near) && (inFlagRow || Math.min(da, dbb) < 12)) {
      mode = da <= dbb ? "a" : "b";
      player.setActive(mode);
    } else { mode = "seek"; player.seek(tAt(e)); }
  });
  c.addEventListener("pointermove", (e) => {
    if (!mode) return;
    if (mode === "seek") { const n = performance.now(); if (n - lastSeek > 60) { lastSeek = n; player.seek(tAt(e)); } }
    else player.setPoint(mode, tAt(e));
  });
  const end = (e) => { if (mode === "seek") player.seek(tAt(e)); mode = null; };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", () => (mode = null));
})();

// fine-tune view: drag the waveform under the fixed centre line (like a jog wheel)
(() => {
  const c = $("#zoom");
  let x0 = null, t0 = 0;
  c.addEventListener("pointerdown", (e) => {
    if (!player.dur()) return;
    c.setPointerCapture(e.pointerId);
    x0 = e.clientX;
    t0 = player.p.active === "a" ? player.A() : player.B();
  });
  c.addEventListener("pointermove", (e) => {
    if (x0 == null) return;
    const W = ZOOMS[player.p.zoomIdx];
    player.setPoint(player.p.active, t0 - ((e.clientX - x0) / c.clientWidth) * W, { keepLock: false });
  });
  const end = () => (x0 = null);
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
})();

// keyboard (tablet / desktop): space play, [ ] set A/B, L loop, ←/→ nudge or seek
document.addEventListener("keydown", (e) => {
  if (!$("#view-player").classList.contains("active")) return;
  if (/input|select|textarea/i.test(e.target.tagName)) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); player.playing ? player.pause() : player.play(); }
  else if (k === "[") player.setHere("a");
  else if (k === "]") player.setHere("b");
  else if (k === "l" || k === "L") player.toggleLoop();
  else if (k === "ArrowLeft") e.altKey ? player.nudge(e.shiftKey ? -0.1 : -0.01) : player.seek(player.now() - 5);
  else if (k === "ArrowRight") e.altKey ? player.nudge(e.shiftKey ? 0.1 : 0.01) : player.seek(player.now() + 5);
});
addEventListener("resize", () => { player.ovCache = null; player.refresh(true); });

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

/* ---------------- sheets: questions & progress ---------------- */
function ask(title, text, options) {
  return new Promise((res) => {
    $("#modalTitle").textContent = title;
    $("#modalText").textContent = text || "";
    $("#modalBarWrap").classList.add("hidden");
    const box = $("#modalBtns");
    box.innerHTML = "";
    for (const o of options) {
      const b = el("button", { className: "btn " + (o.cls || ""), textContent: o.label });
      b.onclick = () => { $("#modal").classList.add("hidden"); res(o.value); };
      box.append(b);
    }
    $("#modal").classList.remove("hidden");
  });
}
const busy = {
  show(title, text = "", frac = null) {
    $("#modalTitle").textContent = title;
    $("#modalText").textContent = text;
    $("#modalBtns").innerHTML = "";
    const wrap = $("#modalBarWrap");
    wrap.classList.remove("hidden");
    wrap.classList.toggle("indeterminate", frac == null);
    if (frac != null) $("#modalBar").style.width = Math.round(frac * 100) + "%";
    $("#modal").classList.remove("hidden");
  },
  hide() { $("#modal").classList.add("hidden"); },
};
// Sharing needs a fresh tap (Safari rejects it after long work), so offer the file with a button.
async function offerFile(blob, filename, title = "Ready") {
  const ok = await ask(title, `${filename} · ${fmtBytes(blob.size)}`, [
    { label: "Save / share", value: true, cls: "primary" },
    { label: "Cancel", value: false, cls: "ghost" },
  ]);
  if (ok) await shareBlob(blob, filename);
}

/* ---------------- MP3 compression (on device) ---------------- */
async function sniff(blob) {
  const u = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const s = (a, b) => String.fromCharCode(...u.subarray(a, b));
  if (s(0, 4) === "RIFF" && s(8, 12) === "WAVE") return "wav";
  if (s(0, 4) === "FORM") return "aiff";
  if (s(0, 4) === "fLaC") return "flac";
  if (s(0, 3) === "ID3" || (u[0] === 0xff && (u[1] & 0xe0) === 0xe0)) return "mp3";
  if (s(4, 8) === "ftyp") return "m4a";
  if (s(0, 4) === "OggS") return "ogg";
  return "other";
}
const needsCompress = async (blob) => ["wav", "aiff", "flac"].includes(await sniff(blob));
function wavRate(ab) {
  const u = new Uint8Array(ab, 0, Math.min(ab.byteLength, 8192));
  const dv = new DataView(ab);
  const id = (o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (id(0) !== "RIFF") return 44100;
  for (let o = 12; o + 16 <= u.length; ) {
    const size = dv.getUint32(o + 4, true);
    if (id(o) === "fmt ") return dv.getUint32(o + 12, true);
    o += 8 + size + (size & 1);
  }
  return 44100;
}
async function toMp3(blob, onProgress) {
  const ab = await blob.arrayBuffer();
  const sr = wavRate(ab);
  const rate = [32000, 44100, 48000].includes(sr) ? sr : 44100;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const buf = await new OAC(2, 1, rate).decodeAudioData(ab);
  const left = buf.getChannelData(0).slice();
  const right = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
  return new Promise((res, rej) => {
    const w = new Worker("mp3-worker.js");
    w.onmessage = (e) => {
      if (e.data.progress != null) onProgress?.(e.data.progress);
      else { w.terminate(); e.data.blob ? res(e.data.blob) : rej(new Error(e.data.error)); }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || "MP3 encoder failed")); };
    w.postMessage({ left, right, sampleRate: buf.sampleRate, kbps: 192 }, [left.buffer, right.buffer]);
  });
}
// stems: [{name, blob}] → compresses big formats in place, reports progress
async function compressStems(stems, report) {
  const todo = [];
  for (const s of stems) if (await needsCompress(s.blob)) todo.push(s);
  for (let k = 0; k < todo.length; k++) {
    const s = todo[k];
    try { s.blob = await toMp3(s.blob, (f) => report(s.name, k, todo.length, f)); }
    catch (e) { console.warn("compress failed, keeping original", e); }
  }
}
async function shrinkTrack(track, report) {
  let saved = 0;
  const list = [];
  for (const s of track.stems) { const b = await db.getBlob(s.key); if (b && (await needsCompress(b))) list.push([s, b]); }
  for (let k = 0; k < list.length; k++) {
    const [s, b] = list[k];
    const nb = await toMp3(b, (f) => report(s.name, k, list.length, f));
    await db.tx(["blobs"], "readwrite", (t) => t.objectStore("blobs").put(nb, s.key));
    saved += b.size - nb.size;
    s.size = nb.size; s.type = nb.type;
  }
  await db.putTrack(track);
  return saved;
}
const looksUncompressed = (t) => t.stems.some((s) => /wav|aiff|flac/i.test(s.type || ""));

/* ---------------- creating library entries ---------------- */
async function createTrack({ title, space = "", stems, practice = null, mixerByIndex = null, created = null }) {
  const id = uid();
  const entries = [], metas = [];
  stems.forEach((s, i) => {
    const key = `${id}:${i}`;
    entries.push([key, s.blob]);
    metas.push({ name: s.name, key, size: s.blob.size, type: s.blob.type || "audio/wav", original: !!s.original });
  });
  const mixer = {};
  (mixerByIndex || []).forEach((m, i) => { if (m && metas[i]) mixer[metas[i].key] = m; });
  const track = { id, title, created: created || Date.now(), space, stems: metas, mixer };
  if (practice) {
    const { waveIndex, ...rest } = practice;
    track.practice = { ...rest, waveKey: waveIndex != null && waveIndex >= 0 ? metas[waveIndex]?.key ?? null : null };
  }
  await db.saveNew(track, entries);
  return id;
}

const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma)$/i;
const baseName = (n) => n.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
function mimeFor(name) {
  const e = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  return { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", aif: "audio/aiff", aiff: "audio/aiff" }[e] || "audio/mpeg";
}
function commonPrefix(names) {
  if (names.length < 2) return "";
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p;
}
const trimSep = (s) => s.replace(/^[\s\-_.()[\]]+|[\s\-_.([]+$/g, "");

async function addAudioFiles(files, mode) {
  const compress = settings.compress;
  const report = (name, k, n, f) => busy.show("Shrinking to MP3…", `${name} (${k + 1}/${n})`, (k + f) / n);
  if (mode === "stems") {
    const names = files.map((f) => baseName(f.name));
    const pre = commonPrefix(names);
    let title = trimSep(pre) || names[0];
    const stems = files.map((f, i) => ({ name: trimSep(names[i].slice(pre.length)) || names[i], blob: f }));
    if (compress) await compressStems(stems, report);
    busy.show("Saving…");
    return [await createTrack({ title, stems })];
  }
  const ids = [];
  for (const f of files) {
    const stems = [{ name: "Full song", blob: f }];
    if (compress) await compressStems(stems, report);
    busy.show("Saving…", f.name);
    ids.push(await createTrack({ title: baseName(f.name), stems }));
  }
  return ids;
}

// The buttons are <label for="addInput">, so the browser opens the picker itself (no scripted click).
// Keyboard users: Enter/Space on the label.
for (const id of ["#btnAddFiles", "#btnImport", "#btnJustLoop"])
  $(id).onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#addInput").click(); } };
$("#addInput").onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  handleAddFiles(files);
};
const isZip = (f) => /\.zip$/i.test(f.name) || /zip/.test(f.type);
const isAudio = (f) => AUDIO_EXT.test(f.name) || /^audio\//.test(f.type);

// drag & drop (desktop): drop on the Separate tab picks the song to split, anywhere else adds to the library
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove("dragging");
  const files = [...e.dataTransfer.files];
  if ($("#view-separate").classList.contains("active") && files.length === 1 && isAudio(files[0])) {
    const dt = new DataTransfer(); dt.items.add(files[0]);
    $("#fileInput").files = dt.files;
    $("#fileInput").dispatchEvent(new Event("change"));
    return;
  }
  handleAddFiles(files);
});

async function handleAddFiles(files) {
  if (!files.length) return;
  const zips = files.filter(isZip);
  const audio = files.filter((f) => !isZip(f) && isAudio(f));
  const ignored = files.length - zips.length - audio.length;
  if (ignored) toast(`Skipped ${ignored} file${ignored > 1 ? "s" : ""} that ${ignored > 1 ? "aren't" : "isn't"} audio or .zip`, 4000);
  if (!zips.length && !audio.length) return;
  let openId = null;
  try {
    for (const z of zips) await importZip(z);
    if (audio.length === 1) openId = (await addAudioFiles(audio, "single"))[0];
    else if (audio.length > 1) {
      const mode = await ask(`${audio.length} audio files`, "How should they be added?", [
        { label: "Stems of one song", value: "stems", cls: "primary" },
        { label: `${audio.length} separate songs`, value: "songs" },
        { label: "Cancel", value: null, cls: "ghost" },
      ]);
      if (mode) { const ids = await addAudioFiles(audio, mode); if (ids.length === 1) openId = ids[0]; else toast(`Added ${ids.length} songs`); }
    }
  } catch (err) {
    console.error(err);
    toast("Couldn't add: " + err.message, 6000);
  }
  busy.hide();
  if (openId) { show("library"); openTrack(openId); }
  else if ($("#view-library").classList.contains("active")) renderLibrary();
  else if (zips.length) show("library");
}

/* ---------------- export / import (.zip) ---------------- */
const safeName = (s) => (s || "untitled").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "untitled";

async function buildZip(tracks) {
  const parts = [];
  let resolve, reject;
  const finished = new Promise((r, j) => { resolve = r; reject = j; });
  const zip = new fflate.Zip((err, chunk, final) => { if (err) return reject(err); parts.push(chunk); if (final) resolve(); });
  const manifest = { format: "stemsplit", version: 1, exported: new Date().toISOString(), songs: [] };
  const folders = new Set();
  const total = tracks.reduce((a, t) => a + t.stems.length, 0);
  let done = 0;
  for (const t of tracks) {
    let folder = safeName(t.title), n = 2;
    while (folders.has(folder)) folder = `${safeName(t.title)} (${n++})`;
    folders.add(folder);
    const song = { title: t.title, created: t.created, space: t.space, stems: [], mixer: {}, practice: null };
    const keyToFile = {};
    const names = new Set();
    for (const s of t.stems) {
      busy.show("Packing backup…", `${t.title} · ${s.name}`, done++ / total);
      const blob = await db.getBlob(s.key);
      if (!blob) continue;
      let fname = safeName(s.name), k = 2;
      while (names.has(fname)) fname = `${safeName(s.name)} ${k++}`;
      names.add(fname);
      const file = `${folder}/${fname}${extFor(blob)}`;
      const entry = new fflate.ZipPassThrough(file); // audio is already compressed: store as-is
      zip.add(entry);
      entry.push(new Uint8Array(await blob.arrayBuffer()), true);
      keyToFile[s.key] = file;
      song.stems.push({ name: s.name, file, type: blob.type, original: !!s.original });
      if (t.mixer?.[s.key]) song.mixer[file] = t.mixer[s.key];
    }
    if (t.practice) {
      const { waveKey, ...rest } = t.practice;
      song.practice = { ...rest, waveFile: keyToFile[waveKey] || null };
    }
    manifest.songs.push(song);
  }
  const mf = new fflate.ZipPassThrough("stemsplit.json");
  zip.add(mf);
  mf.push(fflate.strToU8(JSON.stringify(manifest, null, 1)), true);
  zip.end();
  await finished;
  return new Blob(parts, { type: "application/zip" });
}

async function exportTracks(tracks, filename) {
  if (!tracks.length) return toast("Nothing to export yet");
  const size = tracks.reduce((a, t) => a + t.stems.reduce((b, s) => b + (s.size || 0), 0), 0);
  if (size > 700e6) {
    const go = await ask("Large export", `This backup is about ${fmtBytes(size)}. Very large files can fail on phones. Shrinking to MP3 first, or exporting songs one at a time, is safer.`, [
      { label: "Export anyway", value: true, cls: "primary" }, { label: "Cancel", value: false, cls: "ghost" }]);
    if (!go) return;
  }
  try {
    const blob = await buildZip(tracks);
    await offerFile(blob, filename, "Backup ready");
  } catch (e) {
    busy.hide();
    toast("Export failed: " + e.message, 6000);
  }
}

async function importZip(file) {
  busy.show("Importing…", file.name);
  const data = new Uint8Array(await file.arrayBuffer());
  const files = fflate.unzipSync(data, { filter: (f) => !f.name.startsWith("__MACOSX") && !f.name.endsWith("/") });
  const existing = await db.allTracks();
  const dup = (title, created) => existing.some((t) => t.title === title && t.created === created);
  let added = 0, skipped = 0;
  const mf = files["stemsplit.json"];
  if (mf) {
    const man = JSON.parse(fflate.strFromU8(mf));
    for (const song of man.songs || []) {
      if (dup(song.title, song.created)) { skipped++; continue; }
      const present = (song.stems || []).filter((s) => files[s.file]);
      if (!present.length) continue;
      busy.show("Importing…", song.title, added / man.songs.length);
      const stems = present.map((s) => ({ name: s.name, original: s.original, blob: new Blob([files[s.file]], { type: s.type || mimeFor(s.file) }) }));
      let practice = null;
      if (song.practice) {
        const { waveFile, ...rest } = song.practice;
        practice = { ...rest, waveIndex: present.findIndex((s) => s.file === waveFile) };
      }
      await createTrack({ title: song.title, created: song.created, space: song.space || "", stems, practice, mixerByIndex: present.map((s) => song.mixer?.[s.file]) });
      added++;
    }
  } else {
    // any zip of audio files: one song per folder
    const groups = {};
    for (const [path, u8] of Object.entries(files)) {
      if (!AUDIO_EXT.test(path)) continue;
      const parts = path.split("/");
      const folder = parts.length > 1 ? parts[parts.length - 2] : baseName(file.name);
      (groups[folder] ||= []).push({ path, u8 });
    }
    for (const [folder, list] of Object.entries(groups)) {
      list.sort((a, b) => a.path.localeCompare(b.path));
      const names = list.map((x) => baseName(x.path));
      const pre = list.length > 1 ? commonPrefix(names) : "";
      const stems = list.map((x, i) => ({ name: list.length === 1 ? "Full song" : trimSep(names[i].slice(pre.length)) || names[i], blob: new Blob([x.u8], { type: mimeFor(x.path) }) }));
      if (settings.compress) await compressStems(stems, (name, k, n, f) => busy.show("Shrinking to MP3…", `${folder} · ${name}`, (k + f) / n));
      await createTrack({ title: folder, stems });
      added++;
    }
  }
  busy.hide();
  toast(`Imported ${added} song${added === 1 ? "" : "s"}${skipped ? ` · ${skipped} already in library` : ""}`, 4000);
}

$("#btnExportAll").onclick = async () => {
  const tracks = (await db.allTracks()).sort((a, b) => a.created - b.created);
  exportTracks(tracks, `StemSplit library ${new Date().toISOString().slice(0, 10)}.zip`);
};
$("#btnExportSong").onclick = () => exportTracks([player.track], `${safeName(player.track.title)} (StemSplit).zip`);
$("#btnShrink").onclick = async () => {
  const t = player.track;
  player.close();
  try {
    const saved = await shrinkTrack(t, (name, k, n, f) => busy.show("Shrinking to MP3…", `${name} (${k + 1}/${n})`, (k + f) / n));
    busy.hide();
    toast(`Saved ${fmtBytes(saved)}`);
  } catch (e) { busy.hide(); toast("Couldn't shrink: " + e.message, 5000); }
  await player.open(await db.getTrack(t.id));
};
$("#btnShrinkAll").onclick = async () => {
  const tracks = (await db.allTracks()).filter(looksUncompressed);
  let saved = 0;
  try {
    for (let i = 0; i < tracks.length; i++)
      saved += await shrinkTrack(tracks[i], (name, k, n, f) => busy.show(`Shrinking song ${i + 1} of ${tracks.length}…`, `${tracks[i].title} · ${name}`, (k + f) / n));
  } catch (e) { toast("Stopped: " + e.message, 5000); }
  busy.hide();
  toast(`Saved ${fmtBytes(saved)}`);
  fillSettings();
};

/* ---------------- settings view ---------------- */
function fillSettings() {
  $("#spaceInput").value = settings.space;
  $("#tokenInput").value = settings.token;
  $("#keepOriginal").checked = settings.keepOriginal;
  $("#compressStems").checked = settings.compress;
  updateStorageDetail();
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
  settings.compress = $("#compressStems").checked;
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

$("#keepOriginal").onchange = () => (settings.keepOriginal = $("#keepOriginal").checked);
$("#compressStems").onchange = () => (settings.compress = $("#compressStems").checked);

async function updateStorageDetail() {
  const tracks = await db.allTracks().catch(() => []);
  const size = tracks.reduce((a, t) => a + t.stems.reduce((b, s) => b + (s.size || 0), 0), 0);
  let txt = `${tracks.length} song${tracks.length === 1 ? "" : "s"} · ${fmtBytes(size)}.`;
  if (navigator.storage?.estimate) { const { quota } = await navigator.storage.estimate(); if (quota) txt += ` Room for about ${fmtBytes(quota)}.`; }
  if (navigator.storage?.persisted) txt += (await navigator.storage.persisted()) ? " Protected from automatic clean-up." : (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "" : " Install to your home screen so the browser keeps it.");
  $("#storageDetail").textContent = txt;
  $("#btnShrinkAll").classList.toggle("hidden", !tracks.some(looksUncompressed));
}

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

const APP_VERSION = "6";
$("#appVersion").textContent = `StemSplit version ${APP_VERSION}`;
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").then((r) => r.update()).catch(() => {});
  // a newer version took over: offer a reload (never force it mid-practice)
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) $("#updateBadge").classList.remove("hidden"); });
}
$("#updateBadge").onclick = () => location.reload();
navigator.storage?.persist?.().catch(() => {});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && currentJob && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});

renderParams();
// Warm up the connection in the background so options (model choice etc.) appear.
if (navigator.onLine) connect().then(renderParams).catch(() => {});
