// Service "transcribe": POST the raw audio to config.url, which answers
// 200 {text, duration?, seconds?} or an error {detail}.
// Config (plugins.transcribe-http): url, timeoutSeconds (default 1200: long
// voice messages take minutes to transcribe on the CPU).
import type { Kernel, ServerPlugin, TranscribeService } from "../../kernel/contract.ts";

const plugin: ServerPlugin = {
  start(k: Kernel) {
    const url = String(k.config.url || "");
    const ms = Number(k.config.timeoutSeconds || 1200) * 1000;
    const service: TranscribeService = {
      async transcribe(audio, mime) {
        if (!url) throw new Error("no transcription url configured");
        let r: Response;
        try {
          r = await fetch(url, { method: "POST", body: audio, headers: { "content-type": mime }, signal: AbortSignal.timeout(ms) });
        } catch (e) {
          throw new Error(`transcriber unreachable (${(e as Error).name})`);
        }
        const out = await r.json().catch(() => ({})) as { text?: string; seconds?: number; detail?: string };
        if (!r.ok) throw new Error(out.detail || `transcriber HTTP ${r.status}`);
        return { text: String(out.text || "").trim(), seconds: out.seconds };
      },
    };
    k.services.provide("transcribe", service);
  },
};
export default plugin;
