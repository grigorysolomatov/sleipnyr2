// The look of the whole app as a handful of semantic tokens (CSS variables).
// Plugins style themselves with these variables only, never raw colours, so
// one theme item restyles everything and the three accents keep their meaning:
//   here       where I am (current thread, focus)        default pink
//   attention  asks for my attention                       default green
//   agent      an agent is working (spinner, running)      default purple
// Accents are rare and always come with a shape or label as well.
// The Settings modality's Theme section (web/settings.js) edits the active theme by hand through
// GET/PATCH /tokens; every value is checked here, so only safe values land.
import type { Kernel, ServerPlugin } from "../../kernel/contract.ts";

export const TOKENS = {
  bg: "#000000",
  surface: "#0d0d0d",
  text: "#ffffff",
  "text-muted": "#8a8a8a",
  line: "#333333",
  "accent-here": "#ff0088",
  "accent-attention": "#88ff00",
  "accent-agent": "#a64dff",
  link: "#00e5ff",
  font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  "font-mono": "ui-monospace, 'DejaVu Sans Mono', monospace",
  "font-size": "16px",
  radius: "8px",
};
export type Tokens = typeof TOKENS;

/** the tokens editable by hand and what each accepts: a colour, or whole pixels in a range */
export const EDITABLE: Record<string, { kind: "color" } | { kind: "px"; min: number; max: number }> = {
  "accent-here": { kind: "color" }, "accent-attention": { kind: "color" }, "accent-agent": { kind: "color" },
  link: { kind: "color" }, text: { kind: "color" }, "text-muted": { kind: "color" }, line: { kind: "color" },
  bg: { kind: "color" }, surface: { kind: "color" },
  radius: { kind: "px", min: 0, max: 24 }, "font-size": { kind: "px", min: 12, max: 24 },
};

/** a safe stored value for token k, or null: colours as #rrggbb, sizes as "<n>px" */
export function clean(k: string, v: unknown): string | null {
  const spec = EDITABLE[k];
  if (!spec || typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (spec.kind === "color") {
    const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (!m) return null;
    return "#" + (m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1]);
  }
  const m = s.match(/^(\d{1,3})(px)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= spec.min && n <= spec.max ? `${n}px` : null;
}

export function css(tokens: Partial<Tokens>): string {
  const t = { ...TOKENS, ...tokens };
  const vars = Object.entries(t).filter(([k, v]) => /^[a-z-]+$/.test(k) && !/[;{}<]/.test(String(v)))
    .map(([k, v]) => `  --${k}: ${v};`).join("\n");
  return `:root {\n${vars}\n  color-scheme: dark;\n}\n`;
}

type ThemeData = { name: string; tokens: Partial<Tokens> };

const plugin: ServerPlugin = {
  routes(k: Kernel) {
    const active = () => k.items.list<ThemeData>({ type: "theme", order: "-updated", limit: 1 })[0];
    const saveDefault = () => k.items.create<ThemeData>("theme", { name: "Default (black)", tokens: TOKENS });
    const view = (t: { id: string; updated: number; data: ThemeData }) =>
      ({ id: t.id, updated: t.updated, name: t.data.name, tokens: { ...TOKENS, ...(t.data.tokens || {}) }, defaults: TOKENS });
    return {
      "GET /theme.css": () => {
        const t = active() || saveDefault();
        return new Response(css(t.data.tokens || {}), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
      },
      "POST /commands/default-theme": () => Response.json(saveDefault()),
      // the active theme, every token filled in, plus the defaults (for reset)
      "GET /tokens": () => Response.json(view(active() || saveDefault())),
      // change some tokens of the active theme: {tokens: {name: value | null}}, null = back to the default.
      // All or nothing: one bad name or value refuses the whole change. Never deletes a theme item.
      "PATCH /tokens": async (req: Request) => {
        const b = await req.json().catch(() => null) as { tokens?: Record<string, unknown> } | null;
        const patch = b?.tokens;
        if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length)
          return Response.json({ error: "send {tokens: {name: value}}" }, { status: 400 });
        const next: Record<string, string> = {};
        for (const [name, v] of Object.entries(patch)) {
          if (!EDITABLE[name]) return Response.json({ error: `${name} cannot be changed here` }, { status: 400 });
          const c = v === null ? TOKENS[name as keyof Tokens] : clean(name, v);
          if (!c) return Response.json({ error: `${name}: ${JSON.stringify(v)} is not a valid value` }, { status: 400 });
          next[name] = c;
        }
        const cur = active() || saveDefault();
        const it = k.items.update<ThemeData>(cur.id, { tokens: { ...(cur.data.tokens || {}), ...next } });
        return Response.json(view(it));
      },
    };
  },
};
export default plugin;
