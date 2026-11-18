// Late delivery: a message that waited in a device's outbox says so to the agent.
import { expect, test } from "bun:test";
import { lateNote } from "../plugins/chat/server.ts";

test("late note only when it waited", () => {
  const made = new Date(2026, 10, 18, 14, 2).getTime();
  expect(lateNote({ created: made + 60e3, data: { recordedAt: made } })).toBe("");
  expect(lateNote({ created: made, data: {} })).toBe("");
  const n = lateNote({ created: String(made + 98 * 60e3), data: { recordedAt: made } });
  expect(n).toContain("made at 14:02");
  expect(n).toContain("15:40");
  expect(n).toContain("98 min later");
});
