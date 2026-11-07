// The look of the whole app as a handful of semantic tokens (CSS variables).
// Plugins style themselves with these variables only, never raw colours, so
// one theme item restyles everything and the three accents keep their meaning:
//   here       where I am (current thread, focus)        default pink
//   attention  asks for my attention                       default green
//   agent      an agent is working (spinner, running)      default purple
// Accents are rare and always come with a shape or label as well.
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

export function css(tokens: Partial<Tokens>): string {
  const t = { ...TOKENS, ...tokens };
  const vars = Object.entries(t).filter(([k, v]) => /^[a-z-]+$/.test(k) && !/[;{}<]/.test(String(v)))
    .map(([k, v]) => `  --${k}: ${v};`).join("\n");
  return `:root {\n${vars}\n  color-scheme: dark;\n}\n`;
}

const plugin: ServerPlugin = {
  routes(k: Kernel) {
    const active = () => k.items.list<{ name: string; tokens: Partial<Tokens> }>({ type: "theme", order: "-updated", limit: 1 })[0];
    const saveDefault = () => k.items.create("theme", { name: "Default (black)", tokens: TOKENS });
    return {
      "GET /theme.css": () => {
        const t = active() || saveDefault();
        return new Response(css(t.data.tokens || {}), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
      },
      "POST /commands/default-theme": () => Response.json(saveDefault()),
    };
  },
};
export default plugin;
