// Style hygiene: every selector is defined once per stylesheet (per @media
// block), so trying a look means changing a value, not appending an override.
// check.sh runs this before each deploy; a duplicate fails the deploy.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (n === "node_modules" || n.startsWith(".")) return [];
    return statSync(p).isDirectory() ? cssFiles(p) : n.endsWith(".css") ? [p] : [];
  });
}

/** Rules as { context, selectors } where context is the enclosing at-rule chain. */
export function rules(css: string): { context: string; selectors: string[]; line: number }[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
  const out: { context: string; selectors: string[]; line: number }[] = [];
  const stack: { head: string; kind: "at" | "rule" }[] = [];
  let buf = "", quote = "";
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { buf += ch; if (ch === quote && src[i - 1] !== "\\") quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "{") {
      const head = buf.trim().replace(/\s+/g, " ");
      buf = "";
      if (head.startsWith("@")) { stack.push({ head, kind: "at" }); continue; }
      const inKeyframes = stack.some(s => /^@(-\w+-)?keyframes/.test(s.head));
      stack.push({ head, kind: "rule" });
      if (inKeyframes || stack.filter(s => s.kind === "rule").length > 1) continue;
      out.push({
        context: stack.filter(s => s.kind === "at").map(s => s.head).join(" > "),
        selectors: head.split(",").map(s => s.trim().replace(/\s*([>+~])\s*/g, " $1 ")).filter(Boolean),
        line: lineAt(i),
      });
    } else if (ch === "}") { stack.pop(); buf = ""; }
    else if (ch === ";" && !stack.some(s => s.kind === "rule")) buf = ""; // @import etc.
    else buf += ch;
  }
  return out;
}

/** Selectors defined in more than one rule of the same context, and repeated @keyframes names. */
export function duplicates(css: string): string[] {
  const seen = new Map<string, number>(), dups: string[] = [];
  for (const r of rules(css)) for (const s of r.selectors) {
    const key = `${r.context} | ${s}`;
    if (seen.has(key)) dups.push(`${s}${r.context ? ` (in ${r.context})` : ""}: lines ${seen.get(key)} and ${r.line}`);
    else seen.set(key, r.line);
  }
  const frames = new Map<string, number>();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@(?:-\w+-)?keyframes\s+([\w-]+)/g)) {
    frames.set(m[1], (frames.get(m[1]) || 0) + 1);
  }
  for (const [name, n] of frames) if (n > 1) dups.push(`@keyframes ${name}: defined ${n} times`);
  return dups;
}

test("the checker finds duplicates", () => {
  expect(duplicates(`.a { x: 1 } .b, .a { y: 2 }`)).toHaveLength(1);
  expect(duplicates(`.a>.b { x: 1 } .a > .b { y: 2 }`)).toHaveLength(1);
  expect(duplicates(`.a { x: 1 } @media (max-width: 9px) { .a { y: 2 } }`)).toEqual([]);
  expect(duplicates(`@keyframes k { from { a: 1 } to { a: 2 } } .k { content: "{ .a }" } .a { b: 1 }`)).toEqual([]);
  expect(duplicates(`@keyframes k { to { a: 1 } } @keyframes k { to { a: 2 } }`)).toHaveLength(1);
  expect(duplicates(`/* .a { } */ .a { b: 1 }`)).toEqual([]);
});

for (const file of cssFiles(join(ROOT, "kernel")).concat(cssFiles(join(ROOT, "plugins")))) {
  test(`each selector once: ${relative(ROOT, file)}`, () => {
    expect(duplicates(readFileSync(file, "utf8"))).toEqual([]);
  });
}
