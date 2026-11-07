"""Text to speech for Sleipnyr 2's hands-free voice mode: a small HTTP
service around Kokoro-82M (CPU, about 4x faster than real time).

  POST /api/speak   {"text": "...", "voice"?: "am_michael", "speed"?: 1.0}
                    -> 200 audio/wav (24 kHz mono 16-bit)
  GET  /api/health  -> {"ok": true, "voice": ..., "loaded": bool}

Environment:
  SPEAK_HOST, SPEAK_PORT   where to listen (127.0.0.1:8182)
  SPEAK_VOICE              default Kokoro voice (am_michael)
  SPEAK_THREADS            torch CPU threads (4)
  HF_HOME                  where the model is cached (downloaded once)
One clip is synthesised at a time; replies are spoken a sentence at a time,
so clips are short.
"""
import io
import json
import os
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("SPEAK_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPEAK_PORT", "8182"))
VOICE = os.environ.get("SPEAK_VOICE", "am_michael")
THREADS = int(os.environ.get("SPEAK_THREADS", "4"))
RATE = 24000
MAX_CHARS = 1200
VOICE_RE = re.compile(r"^[a-z]{2}_[a-z]{2,20}$")

_pipe = None
_lock = threading.Lock()  # one clip at a time; also guards the lazy load


class Refused(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status, self.detail = status, detail


def pipeline():
    global _pipe
    if _pipe is None:
        import torch
        from kokoro import KPipeline
        torch.set_num_threads(THREADS)
        _pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    return _pipe


def speak(text, voice, speed):
    import numpy as np
    text = " ".join(str(text or "").split())[:MAX_CHARS]
    if not text:
        raise Refused(400, "empty text")
    if not VOICE_RE.match(voice):
        raise Refused(400, "bad voice name")
    speed = min(1.5, max(0.6, float(speed)))
    with _lock:
        parts = [r.audio.numpy() for r in pipeline()(text, voice=voice,
                                                       speed=speed)
                 if r.audio is not None]
    audio = np.concatenate(parts) if parts else np.zeros(RATE // 10,
                                                         np.float32)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def reply(self, status, obj):
        self.send(status, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        if self.path == "/api/health":
            return self.reply(200, {"ok": True, "voice": VOICE,
                                    "loaded": _pipe is not None})
        self.reply(404, {"detail": "not found"})

    def do_POST(self):
        try:
            if self.path.split("?")[0] != "/api/speak":
                raise Refused(404, "not found")
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > 64_000:
                raise Refused(400, "body must be 1 B - 64 KB of JSON")
            body = json.loads(self.rfile.read(n))
            t0 = time.time()
            wav = speak(body.get("text"), str(body.get("voice") or VOICE),
                        body.get("speed") or 1.0)
            self.send(200, wav, "audio/wav",
                      {"x-seconds": f"{time.time() - t0:.2f}"})
        except Refused as e:
            self.reply(e.status, {"detail": e.detail})
        except (ValueError, TypeError) as e:
            self.reply(400, {"detail": f"bad request: {e}"})
        except Exception as e:  # noqa: BLE001 - report, keep serving
            print("error:", repr(e), flush=True)
            self.reply(500, {"detail": "internal error"})

    def log_message(self, format, *args):  # noqa: A002 - base class name
        print(f"{self.address_string()} {format % args}", flush=True)


if __name__ == "__main__":
    print(f"speak on http://{HOST}:{PORT} (voice {VOICE})", flush=True)
    # warm up: the first clip loads the model and the phonemiser (~10 s)
    threading.Thread(target=lambda: speak("Ready.", VOICE, 1.0),
                     daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
