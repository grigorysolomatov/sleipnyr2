// Minimal headless Chromium over the DevTools protocol, for the smoke test
// and the style comparison (no npm dependencies).
//   const b = await launch(); const p = await b.page(360, 800); ...; await b.close();
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Page {
  send(method: string, params?: object): Promise<any>;
  on(event: string, fn: (p: any) => void): void;
  /** Evaluates an expression (awaits promises) and returns its JSON value; throws on page exceptions. */
  eval<T = unknown>(expr: string): Promise<T>;
  goto(url: string): Promise<void>;
  waitFor(expr: string, ms?: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  /** Uncaught exceptions and console errors seen so far. */
  errors: string[];
}

export async function launch(bin = process.env.CHROMIUM || "chromium") {
  const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sleipnyr2-cdp-"));
  const proc = Bun.spawn([bin, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
    "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(100);
  if (!existsSync(portFile)) { proc.kill(); throw new Error(`chromium did not start (${bin})`); }
  const port = readFileSync(portFile, "utf8").split("\n")[0];

  const close = async () => { proc.kill(); await proc.exited; rmSync(profile, { recursive: true, force: true }); };

  async function page(width = 360, height = 800, mobile = width < 700): Promise<Page> {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
    let seq = 0;
    const waiting = new Map<number, { ok: (v: any) => void; bad: (e: Error) => void }>();
    const subs = new Map<string, ((p: any) => void)[]>();
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id)!; waiting.delete(m.id);
        m.error ? w.bad(new Error(`${m.error.message}`)) : w.ok(m.result);
      } else if (m.method) for (const fn of subs.get(m.method) || []) fn(m.params);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((ok, bad) => {
      const id = ++seq; waiting.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params }));
    });
    const on = (ev: string, fn: (p: any) => void) => { subs.set(ev, [...(subs.get(ev) || []), fn]); };
    const errors: string[] = [];
    on("Runtime.exceptionThrown", p => errors.push("exception: " + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
    on("Runtime.consoleAPICalled", p => { if (p.type === "error") errors.push("console.error: " + p.args.map((a: any) => a.value ?? a.description ?? "").join(" ")); });
    await send("Runtime.enable"); await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const evalJs = async <T>(expr: string): Promise<T> => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value as T;
    };
    return {
      send, on, errors, eval: evalJs,
      async goto(url) {
        const loaded = new Promise(ok => on("Page.loadEventFired", ok));
        await send("Page.navigate", { url });
        await Promise.race([loaded, Bun.sleep(15000)]);
      },
      async waitFor(expr, ms = 10000) {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await evalJs<boolean>(`!!(${expr})`).catch(() => false)) return; await Bun.sleep(100); }
        throw new Error(`timed out waiting for: ${expr}`);
      },
      async screenshot(path) {
        const r = await send("Page.captureScreenshot", { format: "png" });
        await Bun.write(path, Buffer.from(r.data, "base64"));
      },
    };
  }
  return { page, close };
}
