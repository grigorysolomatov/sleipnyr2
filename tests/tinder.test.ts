// Task Tinder: suggestion store, rewording = same task, reject cooldown, accept -> card.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../kernel/server.ts";
import { keyOf, sameTask, Tinder } from "../plugins/tinder/server.ts";

const dir = mkdtempSync(join(tmpdir(), "sleipnyr2-tinder-"));
const app = await createApp({ listen: { host: "127.0.0.1", port: 0 }, dataDir: dir, app: { name: "T", shortName: "T", home: "chat" },
  user: { id: "me", name: "Me" }, plugins: { theme: {}, "agent-hermes": { agents: [] }, "transcribe-http": { url: "" }, chat: { agent: "stub" }, tinder: {} } });
afterAll(() => { app.stop(); rmSync(dir, { recursive: true, force: true }); });

const made: { body: Record<string, unknown>; board: string }[] = [];
const kernel = { items: app.store.items("tinder"), config: { cooldownHours: 24, defaultTier: "strong", tiers: { lab0: { label: "first, not default" }, strong: { model: "big-model", provider: "main", label: "Big" }, lab: { model: "big-model", provider: "lab-seat", label: "Big (lab seat)" } } } } as any;
const t = new Tinder(kernel, async (body, board) => { made.push({ body, board }); return `t_${made.length}`; });

test("a rewording is the same task", () => {
  expect(sameTask(keyOf("Write the README for Sleipnyr 2 plugins"), keyOf("Sleipnyr 2 plugins: write README"))).toBe(true);
  expect(sameTask(keyOf("Write the README for Sleipnyr 2"), keyOf("Back up the Gmail archive"))).toBe(false);
});

test("reject sinks it, keeps it and brings it back after the cooldown", () => {
  const a = t.suggest({ title: "Tidy the garden board", why: "x", board: "garden", tier: "strong", cost: "~10 min" }).item;
  const b = t.suggest({ title: "Draft a note to the landlord", why: "y", board: "home", tier: "nope", cost: "" }).item;
  expect(b.data.tier).toBe("strong");
  const now = Date.now();
  const r = t.reject(a.id, now);
  expect(r.data.state).toBe("rejected");
  expect(r.data.score).toBe(0.5);
  expect(t.queue(now).cards.map(c => c.id)).toEqual([b.id]);
  expect(t.queue(now + 25 * 3600e3).cards.map(c => c.id)).toEqual([b.id, a.id]); // back, below the fresh one
  // the same task reworded is not a new card
  const again = t.suggest({ title: "garden board: tidy it", why: "z", board: "garden" });
  expect(again.merged).toBe(true);
  expect(again.item.id).toBe(a.id);
  const r2 = t.reject(a.id, now + 25 * 3600e3);
  expect(r2.data.score).toBe(0.25);
  expect(r2.data.until).toBe(now + 25 * 3600e3 + 3 * 24 * 3600e3); // second reject waits three times longer
});

test("accept creates one pinned card with the drafts-only rule", async () => {
  const s = t.suggest({ title: "Summarise open research cards", why: "w", board: "research", tier: "lab", cost: "~5 min" }).item;
  const [x, y] = await Promise.all([t.accept(s.id), t.accept(s.id)]);
  expect(x.card).toBe(y.card);
  expect(made.length).toBe(1);
  expect(made[0].board).toBe("research");
  expect(made[0].body.assignee).toBe("default");
  expect(made[0].body.provider_override).toBe("lab-seat");
  expect(String(made[0].body.body)).toContain("drafts only");
  expect(t.get(s.id).data.state).toBe("accepted");
  expect((await t.accept(s.id)).card).toBe(x.card);
  expect(t.suggest({ title: "Summarise the open research cards" }).skipped).toBe("already accepted");
});

test("without configured tiers a card runs on the profile's own model", async () => {
  const k2 = { items: app.store.items("tinder"), config: {}, user: { id: "u", name: "Ada" }, app: { agentName: "Bot" } } as any;
  const out: Record<string, unknown>[] = [];
  const t2 = new Tinder(k2, async body => { out.push(body); return "t_x"; });
  const s = t2.suggest({ title: "Plan the quarterly bird survey route", tier: "whatever" }).item;
  expect(s.data.tier).toBe("default");
  expect(s.data.board).toBe("default");
  await t2.accept(s.id);
  expect(out[0].model_override).toBeUndefined();
  expect(String(out[0].body)).toContain("Accepted by Ada");
  expect(String(out[0].body)).toContain("without Ada's per-message OK");
  expect(t2.settings().tiers).toEqual({ default: { label: "Default model", doc: "" } });
});
