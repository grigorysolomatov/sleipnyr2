# Decision: agents act on views through declared actions

Status: trial (decided 2026-11-05, to be re-evaluated after the first
test). Not final; revisit if the trial shows the blocks are too narrow.

## Question

How should an agent change what is on screen live (for example, blink
the selected thread five times) without a code change and a page reload?

## Options considered

1. Static CSS/JS edits plus deploy. Works today, but needs a reload, is
   permanent until reverted, and is not a live reaction.
2. Agent sends arbitrary JavaScript to the open page. Maximum
   flexibility. Rejected: any sender who reaches the channel (prompt
   injection through a web page or email the agent reads, another bot, a
   future third-party plugin) gets full control of the page, and the
   behaviour is hard to audit or tame later.
3. Declared actions (chosen). Each plugin declares the actions an agent
   may perform on it, as typed tools, in the style of MCP.

## Decision

- Every plugin declares its agent actions: name, typed parameters, short
  description. Example for the thread list: blink(target, times,
  interval_ms, colours), highlight(ids, reason), scroll_to(id),
  open_thread(id).
- The kernel collects all plugins' actions and serves them as one MCP
  server. Agents connect once and see every available tool.
- Security is defined by two things: which actions exist, and which
  agent may call which action. The server enforces both; the page never
  trusts an unchecked call.
- A call is relayed to open pages over the existing event stream
  (/k/events) and runs immediately, with no reload.
- Every call is logged and visible in the thread. One visible stop
  control cancels running effects; a reload always resets them.
- A "run any JavaScript" action is not part of the default set. If ever
  added, it is a separate grant, off by default, never given to
  third-party plugins or other bots.

## Permission levels (added 2026-11-05)

Each action declares a level; each agent gets a grant per plugin,
like file permissions on Linux (file = plugin, user = agent):

1. look: cosmetic, temporary effects (blink, pulse, colour, highlight).
2. read: describe what the view shows (ids, titles, fields).
3. act: navigate and change data (open, rename, hide, create).
4. script: run arbitrary JavaScript in the plugin's page.

Higher levels include lower ones. Script includes everything, so it is
granted per plugin, off by default, never to third-party plugins or
other bots. Grants live on the server; a call above the grant is
refused and logged.

## Consequences

- New kinds of reaction need a new declared action first (plugin code).
  Mitigation: offer generic blocks (highlight, pulse, note, focus) that
  cover many requests.
- The action list doubles as documentation of what an agent can do to
  each view, and is the start of the written HCP contract.
- Permissions become real (enforced) rather than declared only.

## Related changes in the same trial

- Sending from a non-chat view (the thread list) keeps you on that view.
- A collapsible reply popup above the modality bar shows the agent's
  status and answer; the user can close it, the agent can reopen it, and
  it links to the full thread.
- The static pink/yellow blink test (commit 04bb015) is removed.

## Re-evaluation

After the first test, check: were the blocks broad enough for real
requests, was latency acceptable, did the permission check get in the
way? If the blocks keep falling short, reconsider a sandboxed scripting
action rather than raw page JavaScript.
