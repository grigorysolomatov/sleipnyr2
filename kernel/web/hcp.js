// Shared wording for view prompts (HCP: a view acts on the @lines of its
// own conversation). One place, so every view tells the agent the same rules.
export const ONE_SENTENCE = "Reply with ONE short sentence (at most 12 words, shown on a single line)";
export const runs = who => `The ${who} runs these lines itself and does not show them. `
  + "Do not call tools for these lines; to show, point at or play something on screen, "
  + "use the sleipnyr2 view_* tools (view_describe first).";
