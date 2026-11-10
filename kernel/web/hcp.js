// Shared wording for view prompts (HCP: a view acts on the @lines of its
// own conversation). One place, so every view tells the agent the same rules.
export const ONE_SENTENCE = "Reply with ONE short sentence (at most 12 words, shown on a single line)";
export const runs = who => `The ${who} runs these lines itself and does not show them. `
  + "Do not call tools for these lines; to show, point at or play something on screen, "
  + "use the sleipnyr2 view_* tools (view_describe first).";
// A view that answers in its chat by default (no one-line rule): the agent
// replies normally and uses @lines only when asked or when the notes say so.
export const CHAT_FIRST = "Answer in this chat as you normally would (full replies are fine). "
  + "Use the action lines below only when the user asks for a change on screen, or when the notes above say so; "
  + "put each action on its own line after your answer";

// Hidden agent notes for a whole view TYPE (every blackboard, every board),
// kept in the kernel settings (viewNotes[view]); a view's own instance notes
// are its business. Both go first in its prompts via notesBlock().
export const viewNotes = (ctx, view) => String(ctx.settings?.().viewNotes?.[view] || "");
export async function setViewNotes(ctx, view, text) {
  const s = await ctx.api("/k/settings", { method: "PATCH", json: { viewNotes: { [view]: text } } });
  ctx.settingsChanged?.(s);
  return s;
}
/** The prompt's notes block: [[label, text], ...]; empty parts are left out. */
export function notesBlock(who, parts) {
  const body = parts.filter(([, t]) => String(t || "").trim()).map(([l, t]) => `${l}:\n${String(t).trim()}`).join("\n\n");
  return body ? `[Agent notes, hidden from ${who}'s view; follow them]\n${body}\n[End of agent notes]\n\n` : "";
}
