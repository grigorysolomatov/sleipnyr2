// Recording context: the cleaner and the timeline block the agent gets.
import { expect, test } from "bun:test";
import { cleanRecording, clock, recordingNote } from "../plugins/chat/recording.ts";

test("clock", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(12_400)).toBe("0:12");
  expect(clock(83_000)).toBe("1:23");
});

test("timeline block", () => {
  const r = cleanRecording({ ms: 41_000, events: [
    { t: 0, text: "on Columns c_1 'Work', column on screen: c2 'Sleipnyr'; in view: p19 'Recording context'" },
    { t: 12_300, text: "now column on screen: c3 'Misc'" },
    { t: 30_000, text: "folded p6 'Jobs'" },
  ], snaps: [{ t: 0, why: "start", text: "view: columns/c_1 on a 360x800 page; 3 items" }] })!;
  const note = recordingNote(r);
  expect(note).not.toContain("On screen"); // one view all along: the timeline says it
  r.events.push({ t: 35_000, text: "now on Blackboards b_1 'Growth'" });
  const moved = recordingNote(r);
  expect(note.split("\n")[0]).toBe("[While recording this voice message (0:41 long), what the user saw and did on the page: "
    + "0:00 on Columns c_1 'Work', column on screen: c2 'Sleipnyr'; in view: p19 'Recording context'; "
    + "0:12 now column on screen: c3 'Misc'; 0:30 folded p6 'Jobs']");
  expect(moved).toContain("[On screen at 0:00 (start):]\nview: columns/c_1 on a 360x800 page; 3 items");
  // a snapshot the message's own context already holds is not repeated
  expect(recordingNote(r, "view: columns/c_1 on a 360x800 page; 3 items")).not.toContain("On screen");
  expect(moved.split("\n")[0]).toContain("; 0:35 now on Blackboards b_1 'Growth']");
});

test("cleaning: shape, size, nothing", () => {
  expect(cleanRecording(null)).toBeNull();
  expect(cleanRecording({ ms: 5, events: [], snaps: [] })).toBeNull();
  expect(cleanRecording({ events: [{ t: 1, text: "   " }] })).toBeNull();
  const r = cleanRecording({ ms: "9000", events: Array.from({ length: 500 }, (_, i) => ({ t: i, text: "x".repeat(400) + "\n\u0001y" })),
    snaps: Array.from({ length: 9 }, (_, i) => ({ t: -5, text: `${i}`.repeat(9000) })) })!;
  expect(r.ms).toBe(9000);
  expect(r.events.length).toBeLessThanOrEqual(81);
  expect(r.events[0].text.length).toBeLessThanOrEqual(240);
  expect(r.events[0].text).not.toContain("\n");
  expect(r.snaps.length).toBeLessThanOrEqual(4);
  expect(r.snaps.every(s => s.t === 0 && s.text.length <= 2500)).toBe(true);
  expect(JSON.stringify(r).length).toBeLessThan(25_000);
  expect(recordingNote(null)).toBe("");
});
