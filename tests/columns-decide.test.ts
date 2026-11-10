// Columns decisions: accept/comment hand a card to the agent, dismiss archives, reopen, nothing lost.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../kernel/server.ts";
import { Decisions } from "../plugins/columns/server.ts";

const dir = mkdtempSync(join(tmpdir(), "sleipnyr2-decide-"));
const app = await createApp({ listen: { host: "127.0.0.1", port: 0 }, dataDir: dir, app: { name: "T", shortName: "T", home: "chat", agentName: "Ag" },
  user: { id: "me", name: "Me" }, plugins: { theme: {}, "agent-hermes": { agents: [] }, "transcribe-http": { url: "" }, chat: { agent: "stub" }, columns: {} } });
afterAll(() => { app.stop(); rmSync(dir, { recursive: true, force: true }); });

const items = app.store.items("columns");
const made: { body: Record<string, unknown>; board: string }[] = [];
let fail = false;
let on = true;
const k = { items, config: { decideBoard: "inbox" }, user: { id: "me", name: "Me" }, app: { agentName: "Ag" }, settings: () => ({ features: { panelDecisions: on } }) } as any;
const d = new Decisions(k, async (body, board) => { if (fail) throw new Error("proxy down"); made.push({ body, board }); return `t_${made.length}`; });

const board = items.create("columns", { title: "Suggestions", columns: [{ id: "c1", title: "Research" }],
  panels: [
    { id: "p1", col: "c1", order: 0, kind: "note", title: "Plot the spectra", text: "What: plot them.", decide: { state: "open", board: "science", log: [] } },
    { id: "p2", col: "c1", order: 1, kind: "note", title: "Tidy", text: "x", decide: { state: "open", log: [] } },
    { id: "p3", col: "c1", order: 2, kind: "note", title: "Plain note", text: "y" },
  ] });

test("accept records the decision and makes one unassigned card on the panel's board", async () => {
  const out = await d.decide(board.id, { panel: "p1", verdict: "accept", comment: "use the new data" });
  expect(out.card).toBe("t_1");
  const p = (out.item.data as any).panels.find((x: any) => x.id === "p1");
  expect(p.decide.state).toBe("accepted");
  expect(p.decide.card).toEqual({ id: "t_1", board: "science" });
  expect(made[0].board).toBe("science");
  expect(made[0].body.assignee).toBeUndefined();
  expect(String(made[0].body.body)).toContain("use the new data");
  expect(String(made[0].body.body)).toContain("never send");
  // a second accept keeps the first card
  const again = await d.decide(board.id, { panel: "p1", verdict: "accept" });
  expect(again.card).toBeUndefined();
  expect(made.length).toBe(1);
});

test("comment is a change request card; dismiss archives; reopen brings it back; log keeps all", async () => {
  const c = await d.decide(board.id, { panel: "p2", verdict: "comment", comment: "smaller please" });
  expect(c.card).toBe("t_2");
  expect(made[1].board).toBe("inbox"); // no board on the panel: the configured default
  expect(String(made[1].body.title)).toStartWith("Comment: ");
  expect((c.item.data as any).panels.find((x: any) => x.id === "p2").decide.state).toBe("open");
  const x = await d.decide(board.id, { panel: "p2", verdict: "dismiss" });
  expect(x.card).toBeUndefined();
  expect(made.length).toBe(2);
  expect((x.item.data as any).panels.find((p: any) => p.id === "p2").decide.state).toBe("dismissed");
  expect((x.item.data as any).panels.length).toBe(3);
  const r = await d.decide(board.id, { panel: "p2", verdict: "reopen" });
  const p2 = (r.item.data as any).panels.find((p: any) => p.id === "p2");
  expect(p2.decide.state).toBe("open");
  expect(p2.decide.log.map((e: any) => e.verdict)).toEqual(["comment", "dismiss", "reopen"]);
});

test("a failed card is still recorded, with the reason; refusals are clear", async () => {
  fail = true;
  const out = await d.decide(board.id, { panel: "p2", verdict: "accept" });
  fail = false;
  expect(out.error).toBe("proxy down");
  const p2 = (out.item.data as any).panels.find((p: any) => p.id === "p2");
  expect(p2.decide.state).toBe("accepted");
  expect(p2.decide.card).toBeUndefined();
  await expect(d.decide(board.id, { panel: "p3", verdict: "accept" })).rejects.toThrow("takes no decisions");
  await expect(d.decide(board.id, { panel: "p2", verdict: "comment", comment: " " })).rejects.toThrow("empty comment");
  await expect(d.decide(board.id, { panel: "p2", verdict: "delete" })).rejects.toThrow("verdict");
  await expect(d.decide("nope", { panel: "p2", verdict: "accept" })).rejects.toThrow("no such board");
});

test("the route is mounted under /p/columns", async () => {
  const r = await app.fetch(new Request(`http://x/p/columns/${board.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ panel: "p3", verdict: "accept" }) }));
  expect(r.status).toBe(403); // mounted; the real app has panelDecisions off by default
  expect((await r.json()).error).toContain("switched off");
});

test("decisions are refused while the panelDecisions switch is off", async () => {
  on = false;
  try {
    const b = board;
    const before = (items.get(b.id) as any).data.panels.find((x: any) => x.id === "p2").decide.state;
    await expect(d.decide(b.id, { panel: "p2", verdict: "dismiss" })).rejects.toThrow(/switched off/);
    expect((items.get(b.id) as any).data.panels.find((x: any) => x.id === "p2").decide.state).toBe(before);
  } finally { on = true; }
});
