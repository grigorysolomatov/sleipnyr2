// Hands-free talk: what is spoken, spoken controls, cutting a streaming reply.
import { expect, test } from "bun:test";
import { speakable } from "../plugins/talk/server.ts";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import { control, nextPiece } from "../plugins/talk/web/talk.js";

test("speakable drops markup, links and action lines", () => {
  expect(speakable("**Done.** See [the card](/i/x).\n@open t_1\nMEDIA:/a.mp3")).toBe("Done. See the card.");
  expect(speakable("- one\n- two https://x.y/z")).toBe("one two a link");
});

test("spoken controls need the whole turn to be the phrase", () => {
  expect(control("Stop listening.")).toBe("end");
  expect(control("Okay, stop listening")).toBe("end");
  expect(control("Pause.")).toBe("pause");
  expect(control("Resume")).toBe("resume");
  expect(control("Stop.")).toBe("hush");
  expect(control("Stop the timer when the pasta is done")).toBe(null);
});

test("a streaming reply is cut at sentence ends", () => {
  expect(nextPiece("Sure. Then", 0, true, false)).toEqual({ piece: "Sure.", to: 5 });
  expect(nextPiece("Sure. Then", 5, false, false)).toBe(null);
  expect(nextPiece("Sure. Then more", 5, false, true)).toEqual({ piece: " Then more", to: 15 });
  expect(nextPiece("Four times three is twelve.", 0, true, false)).toEqual({ piece: "Four times three is twelve.", to: 27 });
  expect(nextPiece("It costs 3.", 0, true, false)).toBe(null); // may become 3.50
  expect(nextPiece("It costs 3.50 now", 0, true, false)).toBe(null); // not a sentence end
});
