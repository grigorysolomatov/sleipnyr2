// Balance (plugin id limits): money balances and what is left of each AI
// subscription, read only.
// Config plugins.limits.balances = [{id, name, file}], each file a balance
// JSON written by a fetcher (schema_version 1, no secrets):
//   {fetched_at, status: ok|stale|unavailable, balance: {amount, currency},
//    facts: [{label, value}], stale_after?: s, error?: short reason}
// -> balances: [{id, name, amount, currency, facts, updated_at, stale?, error?}]
// Config (plugins.limits): sources = [{id, name, file}], each file a usage
// JSON written by a fetcher on this machine (schema_version 1):
//   {plan, fetched_at, status: ok|stale|unavailable,
//    windows: {five_hour|seven_day|primary|secondary|...: {label, name, remaining_percent, reset_unix}},
//    scoped: [{label, name, remaining_percent, reset_unix}]}
// GET /p/limits/limits -> {providers: [{id, name, plan, windows: [{label, name,
//   left, resets_at, note?}], updated_at, stale?, error?}], fetched_at}
// left = remaining percent 0..100 (null = the source did not report it);
// times are unix seconds. A missing or broken file gives error "no data",
// never a guess. Only these fields leave the server.
import { readFileSync } from "node:fs";
import type { ServerPlugin } from "../../kernel/contract.ts";

export interface Source { id: string; name: string; file: string }
const STALE_S = 20 * 60; // fetchers run every few minutes; older than this = stale
const ORDER = ["five_hour", "primary", "seven_day", "secondary"];
// a window the provider normally has but stopped reporting stays listed
const EXPECT: Record<string, [string, string, string]> = { five_hour: ["five_hour", "5h", "Session"] };

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

export function sourcesOf(list: unknown): Source[] {
  return (Array.isArray(list) ? list : []).flatMap(s => {
    const x = s as Partial<Source>;
    return x && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(x.id)) && x.name && x.file
      ? [{ id: String(x.id), name: String(x.name), file: String(x.file) }] : [];
  });
}

function win(w: any, fallback: string) {
  const rem = num(w?.remaining_percent);
  if (rem == null) return null;
  return { label: String(w?.label || fallback), name: String(w?.name || ""),
    left: Math.round(Math.max(0, Math.min(100, rem)) * 10) / 10, resets_at: num(w?.reset_unix) };
}

/** one provider from its parsed usage file (d), at time now (unix s) */
export function provider(s: { id: string; name: string }, d: any, now: number) {
  const base: any = { id: s.id, name: s.name, plan: null, windows: [], updated_at: null };
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ...base, error: "no data" };
  base.plan = typeof d.plan === "string" ? d.plan : null;
  base.updated_at = num(d.fetched_at);
  const ws = d.windows && typeof d.windows === "object" ? d.windows : {};
  const keys = [...ORDER.filter(k => k in ws), ...Object.keys(ws).filter(k => !ORDER.includes(k))];
  for (const k of keys) { const w = win(ws[k], k); if (w) base.windows.push(w); }
  const got = base.windows.length;
  if (got && ws.seven_day && !win(ws.five_hour, "five_hour")) {
    const [, label, name] = EXPECT.five_hour;
    base.windows.unshift({ label, name, left: null, resets_at: null, note: "not reported" });
  }
  for (const x of Array.isArray(d.scoped) ? d.scoped : []) { const w = win(x, "scoped"); if (w) base.windows.push(w); }
  if (d.status === "unavailable" || !got) return { ...base, error: "no data" };
  if (d.status === "stale" || (base.updated_at != null && now - base.updated_at > STALE_S)) base.stale = true;
  return base;
}

const BAL_STALE_S = 30 * 60; // balance fetchers run every 10 min

/** one money balance from its parsed file (d), at time now (unix s) */
export function balance(s: { id: string; name: string }, d: any, now: number) {
  const base: any = { id: s.id, name: s.name, amount: null, currency: null, facts: [], updated_at: null };
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ...base, error: "no data" };
  base.updated_at = num(d.fetched_at);
  base.amount = num(d.balance?.amount);
  base.currency = typeof d.balance?.currency === "string" ? d.balance.currency.slice(0, 8) : null;
  base.facts = (Array.isArray(d.facts) ? d.facts : []).flatMap((f: any) =>
    f && typeof f.label === "string" && (num(f.value) != null || typeof f.value === "string")
      ? [{ label: f.label.slice(0, 60), value: typeof f.value === "string" ? f.value.slice(0, 60) : f.value }] : []);
  const why = typeof d.error === "string" && d.error ? d.error.slice(0, 60) : null;
  if (d.status === "unavailable" || base.amount == null) return { ...base, error: why || "no data" };
  const staleS = num(d.stale_after) ?? BAL_STALE_S;
  if (d.status === "stale" || (base.updated_at != null && now - base.updated_at > staleS)) base.stale = true;
  if (base.stale && why) base.error = why;
  return base;
}

const readJson = (read: (f: string) => string, f: string) => { try { return JSON.parse(read(f)); } catch { return null; } };

export function limits(sources: Source[], read: (f: string) => string, now = Math.floor(Date.now() / 1000), money: Source[] = []) {
  const providers = sources.map(s => {
    let d: unknown = null;
    try { d = JSON.parse(read(s.file)); } catch { d = null; }
    return provider(s, d, now);
  });
  const balances = money.map(s => balance(s, readJson(read, s.file), now));
  return { balances, providers, fetched_at: now };
}

const plugin: ServerPlugin = {
  routes: k => ({
    "GET /limits": () => Response.json(limits(sourcesOf(k.config.sources), f => readFileSync(f, "utf8"), undefined, sourcesOf(k.config.balances)),
      { headers: { "cache-control": "no-store" } }),
  }),
};
export default plugin;
