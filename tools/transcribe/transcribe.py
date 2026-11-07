"""Speech-to-text sidecar for the transcribe-http plugin.

POST /api/transcribe with the raw clip (any format ffmpeg reads) as the body:
  200 {"text", "language", "duration", "seconds"}
  errors {"detail"}: 400 empty, 413 too large, 422 undecodable or no words.
GET /api/health -> {"ok", "model", "loaded"}.

Local faster-whisper on the CPU (int8), one clip at a time, model loaded on
first use. Standard library HTTP server; needs faster-whisper, numpy, ffmpeg.

Environment:
  TRANSCRIBE_HOST, TRANSCRIBE_PORT   listen address (127.0.0.1:8181)
  TRANSCRIBE_MODEL                   whisper model name or path (small)
  TRANSCRIBE_PROMPT                  words to expect: names, jargon (optional)
  TRANSCRIBE_FFMPEG                  ffmpeg binary (ffmpeg on PATH)
  TRANSCRIBE_MAX_BYTES               largest accepted clip (25 MB)
  TRANSCRIBE_FAST_MODEL              model for ?fast=1 (base.en)

POST /api/transcribe?fast=1 uses the small fast model (hands-free voice
turns: a few seconds of speech in about half a second). It has its own lock,
so a long message being transcribed never holds up a conversation turn.

Long clips are transcribed whole: faster-whisper walks the audio in 30 s
windows, so a 20 min message gives a 20 min transcript (about 1/10 of real
time here). Only audio past MAX_SECONDS is cut, and the text says so.
"""
import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("TRANSCRIBE_HOST", "127.0.0.1")
PORT = int(os.environ.get("TRANSCRIBE_PORT", "8181"))
MODEL = os.environ.get("TRANSCRIBE_MODEL", "small")
FAST_MODEL = os.environ.get("TRANSCRIBE_FAST_MODEL", "base.en")
PROMPT = os.environ.get("TRANSCRIBE_PROMPT", "") or None
FFMPEG = os.environ.get("TRANSCRIBE_FFMPEG", "ffmpeg")
MAX_BYTES = int(os.environ.get("TRANSCRIBE_MAX_BYTES", 25 * 1024 * 1024))
MAX_SECONDS = 40 * 60  # the recorder auto-sends at 30 min
RATE = 16000

_models = {}  # name -> loaded WhisperModel
_locks = {MODEL: threading.Lock(), FAST_MODEL: threading.Lock()}  # one clip
# per model at a time; each lock also guards that model's lazy load


class Refused(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status, self.detail = status, detail


def decode(raw):
    """Clip bytes -> mono 16 kHz float32 samples."""
    import numpy as np
    # a file, not a pipe: mp4/m4a needs seeking (its index is at the end)
    with tempfile.NamedTemporaryFile(suffix=".audio") as f:
        f.write(raw)
        f.flush()
        # asetpts: timestamps from the sample count (browser webm can jump)
        p = subprocess.run(
            [FFMPEG, "-nostdin", "-loglevel", "error", "-i", f.name,
             "-af", "asetpts=N/SR/TB", "-t", str(MAX_SECONDS + 5),
             "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1"],
            capture_output=True, timeout=300)
    audio = np.frombuffer(p.stdout, np.float32)
    if p.returncode or not audio.size:
        err = p.stderr.decode(errors="replace").strip()[-300:]
        print("ffmpeg failed:", err, flush=True)
        raise Refused(422, "could not decode the audio")
    secs = len(audio) / RATE
    # voice opus is at most ~32 kbit/s: far fewer seconds than that = bad decode
    if len(raw) > 64_000 and secs < len(raw) / 64_000:
        raise Refused(422, f"decoded only {secs:.1f} s from "
                           f"{len(raw) // 1024} KB")
    return audio


def transcribe(raw, fast=False):
    if not raw:
        raise Refused(400, "empty audio")
    t0 = time.time()
    audio = decode(raw)
    name = FAST_MODEL if fast else MODEL
    with _locks[name]:
        if name not in _models:
            from faster_whisper import WhisperModel
            _models[name] = WhisperModel(
                name, device="cpu", compute_type="int8",
                cpu_threads=min(8, os.cpu_count() or 2) if fast
                else os.cpu_count() or 2)
        segments, info = _models[name].transcribe(
            audio, beam_size=1, vad_filter=True,
            condition_on_previous_text=False, initial_prompt=PROMPT,
            without_timestamps=fast)
        text = " ".join(s.text.strip() for s in segments).strip()
    secs = len(audio) / RATE
    if not text and secs > 30:  # long and wordless: a failure, not silence
        raise Refused(422, f"no words recognised in {secs:.0f} s of audio")
    if secs > MAX_SECONDS + 1:
        text += f" [cut at {MAX_SECONDS // 60} min]"
    return {"text": text, "language": info.language,
            "duration": round(secs, 1), "seconds": round(time.time() - t0, 1)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def reply(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            return self.reply(200, {"ok": True, "model": MODEL,
                                    "fast": FAST_MODEL,
                                    "loaded": sorted(_models)})
        self.reply(404, {"detail": "not found"})

    def do_POST(self):
        try:
            path, _, query = self.path.partition("?")
            if path != "/api/transcribe":
                raise Refused(404, "not found")
            n = int(self.headers.get("content-length") or 0)
            if n > MAX_BYTES:
                self.close_connection = True  # body left unread
                raise Refused(413, f"audio is larger than "
                                   f"{MAX_BYTES // 1048576} MB")
            fast = "fast=1" in query.split("&")
            self.reply(200, transcribe(self.rfile.read(n) if n > 0 else b"",
                                       fast))
        except Refused as e:
            self.reply(e.status, {"detail": e.detail})
        except Exception as e:  # noqa: BLE001 - report, keep serving
            print("error:", repr(e), flush=True)
            self.reply(500, {"detail": "internal error"})

    def log_message(self, format, *args):  # noqa: A002 - base class name
        print(f"{self.address_string()} {format % args}", flush=True)


if __name__ == "__main__":
    print(f"transcribe on http://{HOST}:{PORT} (model {MODEL}, "
          f"fast {FAST_MODEL})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
