// Bad wifi check: on a phone-sized page, messages sent or arriving while the
// connection drops, hangs or comes back without an "online" event must all end
// up shown in the open thread without a reload, each exactly once.
// Run against a preview copy only (it posts test messages):
//   bun tests/flaky.ts http://127.0.0.1:8189
import { launch } from "./cdp.ts";
const url = (process.argv[2] || "").replace(/\/+$/, "");
if (!url || url.endsWith(":8180")) { console.error("usage: bun tests/flaky.ts <preview url> (never the live app)"); process.exit(2); }

const api = async (path: string, body?: unknown) => (await fetch(url + path, body === undefined ? {} :
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as any;
const t = await api("/p/chat/threads", { title: "(test) bad wifi" });
const tid: string = t.id;
await api(`/p/chat/threads/${tid}/messages`, { text: "flaky: first message", clientId: `seed-${Date.now()}` });

let bad = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) bad++; };
const b = await launch();
try {
  const p = await b.page(360, 800);
  await p.goto(`${url}/i/${tid}`);
  await p.waitFor(`document.querySelectorAll(".c-log > .c-msg").length >= 1`, 20000);
  await Bun.sleep(800);
  const shown = () => p.eval<{ id: string; text: string; note: string }[]>(`[...document.querySelectorAll(".c-log > .c-msg.user")].map(e => ({ id: e.id, text: e.querySelector(".c-text")?.textContent || "", note: e.querySelector(".c-quiet")?.textContent || "" }))`);
  const until = async (fn: () => Promise<boolean>, ms: number) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await Bun.sleep(250); } return false; };
  const type = (text: string) => p.eval(`(() => { document.querySelector(".mb-keys")?.click(); const ta = document.querySelector(".mb textarea");
    ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event("input")); ta.form.requestSubmit(); return 1; })()`)
    .then(() => Bun.sleep(200)).then(() => p.eval(`(() => { const w = document.querySelector(".mb-when"); if (w && !w.hidden) w.querySelector(".mb-def").click(); return 1; })()`)); // agent still busy: Queue
  const onServer = async (text: string) => (await api(`/p/chat/threads/${tid}/messages`) as any[]).filter(m => m.data.role === "user" && m.data.text === text).length;
  const settled = async (text: string) => { const s = await shown(); const mine = s.filter(m => m.text.includes(text)); return mine.length === 1 && mine[0].id.startsWith("m_") && !mine[0].note; };

  // paused requests: "hang" keeps them paused (never answered), "fail" drops them at once
  let mode: "" | "hang" | "fail" = "", match = /./;
  const paused: string[] = [];
  p.on("Fetch.requestPaused", (e: any) => {
    const hit = mode && match.test(`${e.request.method} ${e.request.url}`);
    if (hit && mode === "hang") paused.push(e.requestId);
    else if (hit) p.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "InternetDisconnected" }).catch(() => {});
    else p.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
  });
  await p.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

  // 1. a normal send shows at once and once
  await type("flaky: plain send");
  check(await until(() => settled("flaky: plain send"), 6000), "plain send: own message shown once");

  // 2. the POST hangs: shown at once as sending, then delivered by the outbox retry once the network answers
  mode = "hang"; match = /^POST .*\/messages$/;
  await type("flaky: hung send");
  check(await until(async () => (await shown()).some(m => m.text.includes("flaky: hung send") && /sending/.test(m.note)), 3000), "hung send: shown at once as 'sending…'");
  await Bun.sleep(4000);
  for (const id of paused.splice(0)) await p.send("Fetch.failRequest", { requestId: id, errorReason: "TimedOut" }).catch(() => {});
  check(await until(async () => (await shown()).some(m => m.text.includes("flaky: hung send") && /not sent yet/.test(m.note)), 3000), "hung send: marked 'not sent yet' when it fails");
  mode = "";
  check(await until(() => settled("flaky: hung send"), 30000), "hung send: delivered without reload");
  check(await onServer("flaky: hung send") === 1, "hung send: exactly one copy on the server");

  // 3. offline, then back WITHOUT an "online" event: a send while offline and a
  // message from another device both show up (stream back -> catch-up merge)
  await p.send("Network.enable");
  await p.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  mode = "fail"; match = /./;
  await Bun.sleep(500);
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); // "online" fires now, but nothing gets through yet
  await Bun.sleep(1000);
  await type("flaky: offline send");
  await api(`/p/chat/threads/${tid}/messages`, { text: "flaky: from another device", clientId: `other-${Date.now()}` });
  await Bun.sleep(3000);
  check(await until(async () => (await shown()).some(m => m.text.includes("flaky: offline send")), 2000), "offline send: stays visible while offline");
  const net = await p.eval<boolean>(`!!document.querySelector(".k-net:not([hidden])")`);
  check(net, "offline note shown");
  mode = ""; // the network is back silently (no event)
  check(await until(() => settled("flaky: offline send"), 60000), "offline send: delivered without reload");
  check(await until(async () => (await shown()).some(m => m.text.includes("flaky: from another device")), 60000), "other device's message shown after the drop");
  check(await onServer("flaky: offline send") === 1, "offline send: exactly one copy on the server");
  check(await until(() => p.eval<boolean>(`!document.querySelector(".k-net:not([hidden])")`), 60000), "offline note gone once back");

  // 4. high latency + every server message is on screen once, in order
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: 1500, downloadThroughput: 20000, uploadThroughput: 20000 });
  await type("flaky: slow send");
  check(await until(() => settled("flaky: slow send"), 20000), "slow send: delivered");
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const server = (await api(`/p/chat/threads/${tid}/messages`) as any[]).filter(m => m.data.role === "user").map(m => m.id);
  const dom = (await shown()).map(m => m.id);
  check(JSON.stringify(server) === JSON.stringify(dom), `all ${server.length} user messages shown once, in order`);
  const errs = p.errors.filter(e => !/Failed to load resource|net::ERR|no connection|timed out|ERR_INTERNET|InternetDisconnected/i.test(e));
  check(!errs.length, `no unexpected JS errors${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
} finally { await b.close(); }
console.log(bad ? `${bad} failed` : "bad wifi ok");
process.exit(bad ? 1 : 0);
