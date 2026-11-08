// Pure functions behind agent @lines and the theme editor.
import { expect, test } from "bun:test";
import { extractActions } from "../plugins/chat/server.ts";
import { clean } from "../plugins/settings/server.ts";
import { bad } from "../kernel/contract.ts";

test("extractActions: plain lines, args and the short answer", () => {
  const r = extractActions("Done.\n@open t_1\n@rename t_2 New name");
  expect(r.text).toBe("Done.");
  expect(r.actions).toEqual([{ name: "open", args: "t_1" }, { name: "rename", args: "t_2 New name" }]);
});

test("extractActions: a body runs up to @end, before the next action", () => {
  const r = extractActions("Ok.\n@note Plan\n# Head\n- a\n@end\n@focus w1");
  expect(r.actions[0]).toEqual({ name: "note", args: "Plan", body: "# Head\n- a" });
  expect(r.actions[1]).toEqual({ name: "focus", args: "w1" });
  expect(r.text).toBe("Ok.");
});

test("extractActions: without @end nothing after the line is taken as body", () => {
  const r = extractActions("Ok.\n@note Plan\nnot a body");
  expect(r.actions).toEqual([{ name: "note", args: "Plan" }]);
  expect(r.text).toBe("Ok.\nnot a body");
});

test("extractActions: markdown decoration around an action line", () => {
  const r = extractActions("Sure.\n- `@hide t_9`\n**@open t_3**");
  expect(r.actions.map(a => a.name + " " + a.args)).toEqual(["hide t_9", "open t_3"]);
});

test("theme clean(): colours and sizes", () => {
  expect(clean("bg", "#ABC")).toBe("#aabbcc");
  expect(clean("bg", " #112233 ")).toBe("#112233");
  expect(clean("bg", "red")).toBeNull();
  expect(clean("bg", "#12345")).toBeNull();
  expect(clean("nope", "#000")).toBeNull();
  expect(clean("bg", 3 as unknown as string)).toBeNull();
  expect(clean("radius", "8")).toBe("8px");
  expect(clean("radius", "8px")).toBe("8px");
  expect(clean("radius", "999")).toBeNull();
});

test("bad(): the error's own status, else the default", async () => {
  const r = bad(Object.assign(new Error("gone"), { status: 404 }));
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: "gone" });
  expect(bad(new Error("x")).status).toBe(400);
  expect(bad("plain", 500).status).toBe(500);
});
