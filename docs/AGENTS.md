# For agents installing or operating Sleipnyr 2

You are an agent (for example a Hermes Agent) asked to install, configure or
run Sleipnyr 2 for your user. This page is what you need; `README.md`
explains the architecture and `docs/INSTALL.md` the install steps.

## Ground rules

- Keys live in an environment file (or your secret store), never in
  `config.json`, never in git. The config only names variables (`keyEnv`).
- Data lives in `dataDir` (SQLite + files). Never delete it; back it up
  before risky changes. Archive with `hidden: true`, do not delete items.
- Keep it on 127.0.0.1 plus `tailscale serve` (tailnet only). There is no
  login yet: never expose it with `tailscale funnel` or a public proxy.
  The one exception is the `people` inbox port (a separate listener that
  only takes signed messages from configured peers; `docs/PEERS.md`).
- Test with throwaway threads named "(agent testing, ignore)" and tell your
  user afterwards so they can hide them.

## Config keys (`config.json`, or `services.sleipnyr2.settings` on NixOS)

Top level:

- `listen` {host, port}: default 127.0.0.1:8180.
- `dataDir`: folder for the database and files.
- `app` {name, shortName, home, agentName}: `home` = plugin shown at "/"
  (`chat`); `agentName` = how the UI and prompts name the agent ("Message
  Agent", "Stop Agent"; default "Agent").
- `user` {id, name}: `name` is the user's name in the UI and in prompts
  ("Ada named this thread", "Ada's agreed conventions").
- `plugins` {<id>: settings}: a plugin runs only if its id is a key here.
- `actions` {ackMs, agents}: MCP access for agents (below).

Plugins and their settings (all optional unless marked):

- `theme`: none.
- `agent-hermes` (provides `agent`): `agents` = [{id, name, url, keyEnv,
  titlePrefix}] (required, at least one); `timeoutSeconds` (600);
  `filesUrl` (http://127.0.0.1:8180/k/files, where the agent downloads
  attachments).
- `transcribe-http` (provides `transcribe`): `url`
  (http://127.0.0.1:8181/api/transcribe), `timeoutSeconds`.
- `chat` (needs agent + transcribe): `agent` = the agent id to talk to;
  `apiUrl` (how the agent reaches this app, used in prompts);
  `agentFiles` {url, keyEnv} for `MEDIA:/path` replies.
- `next-thread`: none (a fresh thread when one gets stuck).
- `talk`: `hearUrl`, `speakUrl`, `maxSeconds` (hands-free voice).
- `blackboards`, `columns`: none.
- `projects`: `list` = [{id, title, doc}] (id lowercase, a-z0-9_-).
- `people` (person-to-person chat, no agent; `docs/PEERS.md`): `name`
  (default `user.name`), `keyEnv` (PEOPLE_KEY; the private key, made by
  `bun plugins/people/keygen.ts`), `inbox` {host, port} (127.0.0.1:8183),
  `peers` [{id, name, url, key}]. Without a key and a peer the plugin only
  shows its empty view; nothing listens.
- `tinder` (Task Tinder; creates Kanban cards on swipe right):
  - `kanbanUrl` (http://127.0.0.1:9120) + `keyEnv` (KANBAN_PROXY_KEY): an
    HTTP endpoint accepting `POST /api/plugins/kanban/tasks?board=<slug>`
    with `{title, body, assignee, model_override?, provider_override?,
    workspace_kind}` and answering `{task: {id}}`, bearer key. With Hermes
    this is the dashboard's Kanban API, ideally behind a small proxy that
    allows only this call.
  - `assignee` ("default"), `defaultBoard` ("default"), `cooldownHours` (24).
  - `tiers` {id: {label, model?, provider?, doc?}}: the choices the agent
    may give a suggestion; `defaultTier` names the default (else the first;
    NixOS sorts attribute names, so set it there); no model = the
    assignee profile's own model. Default: one tier "default".
  - `rules` [lines]: appended to every accepted card; `{user}` = the user's
    name. Default: a no-email-without-OK rule.
  - `sources`: extra places to look for task ideas (one phrase, e.g. "the
    notes folder /srv/notes").
  - `apiUrl`: how the agent reaches this app.

The NixOS module fills `listen`, `dataDir` and the sidecar URLs itself.

## MCP actions (live effects on the user's open pages)

`POST /k/mcp` is an MCP server (JSON-RPC over HTTP). An agent authenticates
with `Authorization: Bearer <key>`; its key and grants come from the config:

```json
"actions": { "ackMs": 2500, "agents": {
  "main": { "keyEnv": "SLEIPNYR2_MCP_KEY", "grants": { "chat": "look", "view": "act" } } } }
```

- Levels, lowest to highest: look, read, act, script. A grant of a level
  allows that level and below for that plugin; `view` is the kernel's own
  generic view tools.
- Tools: chat_blink, chat_glow, chat_highlight, chat_select, chat_scroll,
  chat_mark, chat_reply_open (plugin `chat`, look); view_describe,
  view_mark, view_scroll_to, view_focus, view_animate, view_order (`view`).
  Call view_describe first to get item ids.
- A call reaches every open page; "running" means a page accepted it, not
  that the user saw it. Audit: `GET /k/actions`; stop all:
  `POST /k/actions/stop`.
- An agent without an entry, or with a wrong key, gets 401. Tools are
  listed only for granted plugins.
- New tools: a plugin declares `actions` in its manifest and handles them
  in its web code (`ctx.actions.handle`); see
  `docs/decision-agent-actions.md`.

## How turns reach the agent

Each chat thread is one Hermes session. A message becomes a background run
(`POST /v1/runs`), streamed back (`GET /v1/runs/<id>/events`); after a
restart the kernel resumes the same run. Messages sent from a view (thread
list, Columns, Blackboards, Tinder) carry a bracketed note describing the
view; the agent answers with one short sentence plus `@name args` action
lines that the page runs (open, rename, hide, add, move...). The note lists
the allowed lines; never invent others.

## Kanban report-back (optional)

With `kanbanReport` enabled (or `tools/kanban-report/kanban_report.py` running),
a finished card posts a notice into its origin thread, which gives you a turn
without a user message: report the card's result plainly. Origin = the thread
of the Hermes session that created the card; to pin it, put
`origin: sleipnyr2:<thread id>` on its own line in the card body. Notices are
idempotent (key = board, card, event), so never repeat one yourself.

## Deploy, rollback, tests

- `tests/check.sh`: TypeScript check, syntax check of every web file, unit
  tests, CSS duplicate check. Must pass before any commit.
- `deploy/deploy.sh`: check, release folder, preview + headless smoke
  test, switch, live smoke test, automatic switch-back on failure.
  `deploy/deploy.sh rollback` = previous release. Needs sudo, bun on PATH,
  and `CHROMIUM` for the smoke test.
- `bun tests/smoke.ts <url>`: app loads at 360x800 and 1280x800, no JS
  errors.
- `bun tests/design.ts <url> <shotdir>`: tours the views with automated
  design checks (`docs/design-rubric.md`).
- After a deploy, open pages show "New version": the user taps it.

## Adding a plugin

A folder `plugins/<id>/` with `manifest.json` (id, version, contract,
provides/needs, optional `modality` {title, doc, icon}, permissions), an
optional `server.ts` (default export: start/stop/routes) and web files.
Enable it under `plugins` in the config (on NixOS: in the module settings,
then rebuild). Plugins never import each other; they talk through kernel
items, events and services.
