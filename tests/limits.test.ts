// Rate limits: usage files -> remaining percent per window, never a guess.
import { expect, test } from "bun:test";
import { balance, limits, provider, sourcesOf } from "../plugins/limits/server.ts";

const now = 1_800_000_000;
test("windows in order, scoped after, missing session kept as not reported", () => {
  const p = provider({ id: "c", name: "Claude" }, { plan: "max", fetched_at: now - 60, status: "ok",
    windows: { seven_day: { label: "7d", name: "Week", remaining_percent: 11, reset_unix: now + 100 } },
    scoped: [{ label: "7d", name: "Other week", remaining_percent: 100, reset_unix: now + 100 }] }, now);
  expect(p.plan).toBe("max");
  expect(p.windows.map((w: any) => [w.name, w.left])).toEqual([["Session", null], ["Week", 11], ["Other week", 100]]);
  expect(p.stale).toBeUndefined();
  expect(p.error).toBeUndefined();
});

test("old reading is stale, broken or missing file is no data", () => {
  const p = provider({ id: "x", name: "X" }, { fetched_at: now - 3600, windows: { primary: { label: "5h", remaining_percent: 50 } } }, now);
  expect(p.stale).toBe(true);
  const r = limits(sourcesOf([{ id: "a", name: "A", file: "/a" }, { id: "b", name: "B", file: "/b" }, { id: "BAD", name: "", file: "" }]),
    f => { if (f === "/a") return "{not json"; throw new Error("ENOENT"); }, now);
  expect(r.providers.map((p: any) => [p.id, p.error])).toEqual([["a", "no data"], ["b", "no data"]]);
});

test("money balance: amount + facts, old is stale, missing amount is no data", () => {
  const b = balance({ id: "vast", name: "Vast.ai" }, { fetched_at: now - 60, status: "ok", balance: { amount: 13.81, currency: "USD" },
    facts: [{ label: "Running instances", value: 0 }, { label: 5, value: 1 }], api_key: "x" }, now);
  expect([b.amount, b.currency, b.facts, b.stale, b.error, "api_key" in b]).toEqual([13.81, "USD", [{ label: "Running instances", value: 0 }], undefined, undefined, false]);
  expect(balance({ id: "v", name: "V" }, { fetched_at: now - 7200, balance: { amount: 1 } }, now).stale).toBe(true);
  expect(balance({ id: "v", name: "V" }, { status: "unavailable" }, now).error).toBe("no data");
  const r = limits([], () => "{}", now, sourcesOf([{ id: "v", name: "V", file: "/v" }]));
  expect(r.balances.map((x: any) => x.error)).toEqual(["no data"]);
});
