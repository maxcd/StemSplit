#!/usr/bin/env python3
"""StemSplit local engine: runs Demucs on this computer for the StemSplit web app.

Start it with:   python stemsplit_local.py
Then in StemSplit → Settings → Engine choose "This computer".

It only listens on 127.0.0.1 (this computer), so nothing on your network can reach it.
Models download once (about 80 MB each, from Hugging Face) the first time you use them.
"""
import argparse
import io
import json
import math
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = 1
MODELS = [
    {"id": "htdemucs_6s", "label": "6 stems: vocals, drums, bass, guitar, piano, other"},
    {"id": "htdemucs", "label": "4 stems: vocals, drums, bass, other (fastest)"},
    {"id": "htdemucs_ft", "label": "4 stems, best quality (about 4× slower)"},
]
MODEL_IDS = {m["id"] for m in MODELS}
MAX_UPLOAD = 300 * 1024 * 1024  # 300 MB

JOBS = {}          # id -> job dict
WORK = queue.Queue()
MODEL_CACHE = {}
DEVICE = "cpu"


def pick_device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def get_model(name):
    if name not in MODEL_CACHE:
        from demucs.pretrained import get_model as load
        model = load(name)
        model.eval()
        MODEL_CACHE[name] = model
    return MODEL_CACHE[name]


class Cancelled(BaseException):
    """Raised from the progress callback to stop a running separation."""


def load_audio(path, samplerate, channels):
    """Decode any audio file with ffmpeg (through Demucs)."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed. Install it first, e.g. `sudo apt install ffmpeg`.")
    from demucs.audio import AudioFile
    try:
        return AudioFile(path).read(streams=0, samplerate=samplerate, channels=channels)
    except Exception as e:
        raise RuntimeError("Couldn't read this audio file. Is it a normal song file (mp3, wav, m4a, flac…)?") from e


def to_int16_interleaved(t):
    import torch
    peak = float(t.abs().max())
    if peak > 1.0:          # avoid clipping: scale the stem down just enough
        t = t / (peak * 1.01)
    return (t.clamp(-1, 1) * 32767).round().to(torch.int16).t().contiguous().numpy().tobytes()


def encode(t, samplerate, fmt):
    pcm = to_int16_interleaved(t)
    if fmt == "wav":
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(t.shape[0]); w.setsampwidth(2); w.setframerate(samplerate)
            w.writeframes(pcm)
        return buf.getvalue(), "audio/wav", "wav"
    import lameenc
    enc = lameenc.Encoder()
    enc.set_bit_rate(256)
    enc.set_in_sample_rate(samplerate)
    enc.set_channels(t.shape[0])
    enc.set_quality(2)
    return bytes(enc.encode(pcm) + enc.flush()), "audio/mpeg", "mp3"


def run_job(job):
    import torch
    from demucs.apply import apply_model, BagOfModels

    def update(**kw):
        job.update(kw)
        job["updated"] = time.time()

    try:
        update(state="loading", message="Loading model (first time: downloading, about 80 MB)…", progress=0)
        model = get_model(job["model"])
        n_models = len(model.models) if isinstance(model, BagOfModels) else 1

        update(state="loading", message="Reading audio…")
        wav = load_audio(job["input"], model.samplerate, model.audio_channels)
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        wav = (wav - mean) / std
        length = wav.shape[-1]

        done = {"n": 0}
        segment = float(getattr(model, "segment", 10) if not isinstance(model, BagOfModels) else model.models[0].segment)
        stride = segment * model.samplerate * 0.75
        per_model = max(1, math.ceil(length / stride))
        total = per_model * n_models

        def callback(d):
            if job.get("cancel"):
                raise Cancelled()
            if d.get("state") == "end":
                done["n"] += 1
                update(progress=min(0.99, done["n"] / total))

        update(state="separating", message=f"Separating on {DEVICE.upper()}…", progress=0)
        with torch.no_grad():
            sources = apply_model(model, wav[None], device=DEVICE, shifts=1, split=True, overlap=0.25,
                                  progress=False, num_workers=0, callback=callback)[0]
        sources = sources * std + mean

        update(state="encoding", message="Saving stems…", progress=0.99)
        stems = []
        for name, src in zip(model.sources, sources):
            data, mime, ext = encode(src.cpu(), model.samplerate, job["format"])
            fname = f"{name}.{ext}"
            with open(os.path.join(job["dir"], fname), "wb") as f:
                f.write(data)
            stems.append({"name": name, "file": fname, "type": mime, "size": len(data)})
        update(state="done", message="Done", progress=1.0, stems=stems)
    except Cancelled:
        update(state="cancelled", message="Cancelled")
    except RuntimeError as e:
        update(state="error", message=str(e))
    except Exception as e:  # report to the app instead of crashing the server
        update(state="error", message=f"{type(e).__name__}: {e}")
    finally:
        try:
            os.remove(job["input"])
        except OSError:
            pass


def worker():
    while True:
        job = WORK.get()
        if job.get("cancel"):
            job.update(state="cancelled", message="Cancelled")
            continue
        run_job(job)


def cleanup_loop():
    """Forget finished jobs after an hour so temporary files don't pile up."""
    while True:
        time.sleep(300)
        now = time.time()
        for jid, job in list(JOBS.items()):
            if job["state"] in ("done", "error", "cancelled") and now - job["updated"] > 3600:
                shutil.rmtree(job["dir"], ignore_errors=True)
                JOBS.pop(jid, None)


def public(job):
    out = {k: job[k] for k in ("id", "state", "message", "progress", "model", "format")}
    out["position"] = sum(1 for j in JOBS.values() if j["state"] == "queued" and j["created"] < job["created"])
    if job.get("stems"):
        out["stems"] = [{**s, "url": f"/jobs/{job['id']}/{s['file']}"} for s in job["stems"]]
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "StemSplitLocal/1"

    def log_message(self, fmt, *args):  # keep the terminal tidy
        if not self.path.startswith("/jobs/") or self.command != "GET":
            print(time.strftime("%H:%M:%S"), self.command, self.path.split("?")[0], fmt % args if "code" in fmt else "")

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if not parts or parts == ["info"]:
            return self.send_json({"name": "StemSplit local engine", "version": VERSION, "device": DEVICE,
                                   "models": MODELS, "formats": ["mp3", "wav"],
                                   "busy": sum(1 for j in JOBS.values() if j["state"] in ("queued", "loading", "separating", "encoding"))})
        if len(parts) >= 2 and parts[0] == "jobs" and parts[1] in JOBS:
            job = JOBS[parts[1]]
            if len(parts) == 2:
                return self.send_json(public(job))
            stem = next((s for s in job.get("stems", []) if s["file"] == parts[2]), None)
            if stem:
                with open(os.path.join(job["dir"], stem["file"]), "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.cors()
                self.send_header("Content-Type", stem["type"])
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path.rstrip("/") != "/jobs":
            return self.send_json({"error": "not found"}, 404)
        q = parse_qs(url.query)
        model = q.get("model", ["htdemucs_6s"])[0]
        fmt = q.get("format", ["mp3"])[0]
        if model not in MODEL_IDS or fmt not in ("mp3", "wav"):
            return self.send_json({"error": "unknown model or format"}, 400)
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_UPLOAD:
            return self.send_json({"error": "file missing or too large"}, 413)
        jid = uuid.uuid4().hex[:12]
        d = tempfile.mkdtemp(prefix=f"stemsplit-{jid}-")
        name = os.path.basename(self.headers.get("X-Filename") or "song")
        ext = os.path.splitext(name)[1][:6] or ".audio"
        path = os.path.join(d, "input" + ext)
        with open(path, "wb") as f:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        now = time.time()
        job = {"id": jid, "state": "queued", "message": "Waiting…", "progress": 0, "model": model, "format": fmt,
               "input": path, "dir": d, "created": now, "updated": now, "name": name}
        JOBS[jid] = job
        WORK.put(job)
        print(time.strftime("%H:%M:%S"), f"new job {jid}: {name} ({length / 1e6:.1f} MB, {model}, {fmt})")
        self.send_json(public(job), 201)

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) == 2 and parts[0] == "jobs" and parts[1] in JOBS:
            JOBS[parts[1]]["cancel"] = True
            return self.send_json({"ok": True})
        self.send_json({"error": "not found"}, 404)


def main():
    global DEVICE
    ap = argparse.ArgumentParser(description="StemSplit local engine")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1", help="keep 127.0.0.1 unless you know what you're doing")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        print("WARNING: ffmpeg not found. MP3/M4A input may fail. Install it: sudo apt install ffmpeg")
    try:
        DEVICE = pick_device()
    except ImportError:
        raise SystemExit("PyTorch is not installed. See the README in this folder.")

    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=cleanup_loop, daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"\n  StemSplit local engine is running on http://{args.host}:{args.port}  (device: {DEVICE})")
    print("  In the app: Settings → Engine → This computer. Press Ctrl+C here to stop.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
