// Headless browser smoke test of a running Sleipnyr 2 (deploy.sh runs it
// before and after switching releases):
//   bun tests/smoke.ts <url> [screenshot-dir]
// Passes when, on a phone-sized and a desktop-sized page, the app loads, a
// thread with messages opens and shows them, and the page throws no errors.
import { launch } from "./cdp.ts";

const url = (process.argv[2] || "http://127.0.0.1:8180").replace(/\/+$/, "");
const shots = process.argv[3];

const threads = await (await fetch(`${url}/p/chat/threads`)).json() as { id: string }[];
let thread = "", count = 0;
for (const t of threads.slice(0, 10)) {
  const msgs = await (await fetch(`${url}/p/chat/threads/${encodeURIComponent(t.id)}/messages`)).json() as unknown[];
  if (msgs.length) { thread = t.id; count = msgs.length; break; }
}

const b = await launch();
const fails: string[] = [];
try {
  for (const [name, w, h] of [["phone", 360, 800], ["desktop", 1280, 800]] as const) {
    const p = await b.page(w, h);
    try {
      await p.goto(`${url}/`);
      await p.waitFor(`document.querySelector(".c-shell") || document.querySelector(".boot.error")`);
      const bootError = await p.eval<string>(`document.querySelector(".boot.error")?.textContent || ""`);
      if (bootError) throw new Error(bootError);
      if (thread) {
        await p.goto(`${url}/i/${encodeURIComponent(thread)}`);
        await p.waitFor(`document.querySelectorAll(".c-msg").length > 0`);
        const shown = await p.eval<number>(`document.querySelectorAll(".c-msg").length`);
        const visible = await p.eval<boolean>(`!!document.querySelector(".c-msg")?.getClientRects().length`);
        if (!visible) throw new Error("messages are in the page but not visible");
        console.log(`${name}: thread ${thread} shows ${shown} of ${count} messages`);
      } else if (threads.length) throw new Error("no thread with messages to open");
      await Bun.sleep(500); // late errors (timers, event stream)
      if (shots) await p.screenshot(`${shots}/smoke-${name}.png`);
      if (p.errors.length) throw new Error(p.errors.join("; "));
    } catch (e) {
      fails.push(`${name}: ${(e as Error).message}`);
    }
  }
} finally {
  await b.close();
}
if (fails.length) { console.error("smoke test FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("smoke test ok");
