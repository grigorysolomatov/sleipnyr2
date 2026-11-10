# Sleipnyr 2

A small personal app for working with agents: a kernel that keeps saved
items and links, and plugins that do everything else. Version 1 ships one
real plugin set: a chat with an agent (threads, voice messages, pasted
screenshots), installable as a PWA on phone and PC.

## Quick start

```
git clone https://github.com/grigorysolomatov/sleipnyr2.git
cd sleipnyr2
bun install
cp config.example.json config.json   # set user.name, app.agentName, agent URL
HERMES_API_KEY=... bun kernel/server.ts config.json
```

Open http://127.0.0.1:8180/. Requirements: [Bun](https://bun.sh) 1.3+ and,
for the agent, a [Hermes Agent](https://hermes-agent.nousresearch.com/docs)
API server (or anything speaking the same `/api/sessions` + `/v1/runs`
protocol). Voice messages also need the speech-to-text sidecar
(`tools/transcribe`, Python with faster-whisper and ffmpeg) or any service
with the same request and response; spoken replies need `tools/speak`
(Kokoro).

- Full server install (systemd, sidecars, HTTPS over Tailscale, NixOS
  module): `docs/INSTALL.md`.
- What an agent operating an installation must know (config keys, plugins,
  MCP actions, deploy, tests): `docs/AGENTS.md`.

Licence: MIT (`LICENSE`).

## Layout

```
kernel/
  contract.ts     the plugin contract (types only) - read this first
  store.ts        items, links, file bytes (SQLite + content-addressed files)
  server.ts       config, plugin loading, HTTP API, web files
  web/            the shell: index.html, shell.js, bar.js (modality bar),
                  voice.js (recording), sw.js, icons
plugins/<id>/
  manifest.json   what the plugin is, its commands and permissions
  server.ts       optional: runs inside the kernel
  web/            optional: browser files
tools/transcribe/ speech-to-text sidecar (HTTP)
deploy/           deploy.sh (release folders, rollback), NixOS module
tests/            check.sh = type check + unit tests
```

## The kernel contract (version 1)

The kernel knows three things, and nothing about chats, agents or themes:

- **Items.** A saved thing: `{id, type, data, created, updated, by}`. The id
  is permanent and is the item's address: `/i/<id>` opens it. There is no
  tree and no folders; structure comes from links. Nothing is deleted in v1.
- **Links.** `(src, rel, dst)` between two item ids, e.g. a message `in` a
  thread, a message `file` an image. Queries can ask for "items linked to X".
- **Files.** Bytes stored by content hash; each file is also an item of
  type `file` (name, mime, size, sha256).

Plugins get a `Kernel` object (see `kernel/contract.ts`) with `items`,
`links`, `files`, `events` (live, unsaved notifications such as streamed
text), `services` (one plugin provides a named service, others use it),
their own `config` section and `user`. Plugins never import each other or
kernel internals, so the kernel and any plugin can be replaced as long as
the contract holds.

A plugin's `manifest.json`:

| field         | meaning                                                      |
|---------------|--------------------------------------------------------------|
| `id`          | folder name                                                  |
| `contract`    | contract version it was written for (must match the kernel)  |
| `commands`    | `{name, doc, key?}` it offers                                |
| `permissions` | `read` / `write` item types, `network` hosts it contacts     |
| `provides`    | service names it registers                                   |
| `needs`       | services it uses (startup fails if no plugin provides one)   |
| `web`         | `entry` module exporting `mount(root, ctx)`, `styles`        |

Permissions are declared but not enforced yet; enforcement is the next
contract version.

Well-known services in v1: `agent` (`AgentService`: send a turn, get a
stream of `delta` / `progress` / `state` / `done` / `error` events) and
`transcribe` (`TranscribeService`: audio bytes to text).

### HTTP

```
GET    /k/items?type=&rel=&to=&order=&limit=   list items
GET    /k/items/<id>                          one item
POST   /k/items          {type, data}         create
PATCH  /k/items/<id>     {key: value|null}    shallow merge (null removes)
GET    /k/links?src=&rel=&dst=                list links
POST   /k/links          {src, rel, dst}      add
POST   /k/files?name=    body = bytes         store a file (content-type = mime)
GET    /k/files/<id>                          file bytes
GET    /k/events?topic=a&topic=b              server-sent events {topic, data}
GET    /k/plugins                             contract, app info, manifests
*      /p/<plugin>/...                        the plugin's own routes
GET    /p/<plugin>/web/...                    its web files (.ts converted per request)
GET    /i/<id>                                the app, opened at that item
```

The kernel publishes topic `item` with `{item}` on every create and update.

### Browser side

The shell (`kernel/web/shell.js`, plain JavaScript) loads every plugin's
styles and mounts the home plugin's `web.entry` with a `ctx` holding a small
client: `api`, `upload`, `fileUrl`, `on(topic, fn)`, `onReconnect`,
`address`, `go`, `route`, `bar`. Any other plugin with a `web.entry` is an
extension: its module exports `extend(host, ctx)`, where `host` is what the
home plugin's `mount` returned (the chat returns its bar, log and composer,
the open thread, `open(thread)`, `messageEl(message)` and `onDraw(fn)`;
`composer` is now the shell's bar element).

Levels (`ctx.levels`, `ctx.embed`): the top level is the modality picker
at `/m`, a list of the composed modalities = ways of working with the agent
(Threads, Projects, later Kanban and others). A plugin is one when its
manifest has `modality: {title, doc, icon}` (icon = inline stroked SVG) and
its web entry exports `mount(box, ctx)`; it is mounted on first visit at
`/m/<id>[/<sub>]`. The home plugin is the default level (`/`, `/i/<id>`).
`ctx.levels.up()` goes to the picker, `go(id, sub)` to a place inside a
modality, `onChange(fn(id, sub))` follows. `ctx.embed(view, box, opts)`
moves the home plugin's embedded chat into a level's box, showing that
level's own conversation (`view:<view>`); `opts.describe()` gives the agent
what is on screen and `opts.run(name, args)` runs its `@name args` lines.

The modality bar (`kernel/web/bar.js`, `ctx.bar`) is the Human Context
Protocol (HCP): every plugin view is its own little website with its own
controls and also respects HCP; Sleipnyr is a browser of such views
(exploratory naming, see `docs/design-modality-bar.md`). It is the one bottom
bar every view shares: attach, keyboard, mic, recording, text, send, with tooltips and
the keys Alt+M / Alt+V / Enter. The shell owns it; a view only says where its
input goes (added to contract v1, no version bump; see
`docs/design-modality-bar.md`):

```js
const withdraw = ctx.bar.offer({
  id: "thread", label: () => "Its title",
  shown: () => true,                  // on screen now?
  send: async ({ text, files, voice }) => { /* post it; throw = not sent */ },
});
ctx.bar.focus("thread");              // the target the bar talks to
ctx.bar.onChange((id, several) => {}) // several views on screen: mark `id`
```

The bar sends to the focused target, or to the one on screen when that is
hidden (phone). When several targets are on screen (PC), the bar names the
focused one at its left edge in the "you are here" accent; tapping the name
switches. A tap inside a view focuses it.
TypeScript web files are converted per request
(no build step); the shell and the chat are plain JavaScript so they keep
loading even if a conversion breaks.

## Settings

The `settings` plugin (formerly `theme`; the old name, `/p/theme` and
`/m/theme` still work) is the Settings modality, set by hand:

- Theme: the look (below).
- Picker: one "Show in picker" switch per modality.
- Features: the app's on/off switches. The config's `app.features` gives the
  defaults; a change in Settings overrides it for every device.
- Data: `allowDelete`, off by default. When on, archived threads get a delete
  button and the agent may `@delete` an archived thread from the thread list.
  The server refuses every delete while it is off (`items.remove`, `DELETE
  /k/items/:id`, `DELETE /p/chat/threads/:id`). Deleting a thread removes its
  messages and links, and each uploaded file that nothing else refers to.

Features and Data are one kernel-owned item (type `settings`):
`GET /k/settings` -> `{allowDelete, features, pickerHidden, viewNotes}`, `PATCH /k/settings` with
`{"allowDelete": true}` or `{"features": {"recent": false}}` (null = back to
the config default). `pickerHidden` is a list of modality ids left out of the
picker (they stay reachable by address); unknown ids are refused with 400, null
= back to the config's `app.pickerHidden`. Settings > Picker has one switch per
modality. Pages follow a change live.
`viewNotes` are hidden agent notes per view type (`{"blackboards": "text"}`),
shown at the top of every prompt from any instance of that view (all
blackboards); the config's `app.viewNotes` are the defaults, `""` clears one,
null = back to the default (4000 characters each). Blackboards edits them in
its memo popover ("All blackboards") and by `@memo-all <text>` /
`@memo-all-clear`; the per-board notes stay in the board item (`@memo`).
Each blackboard has its own embedded conversation (`chatView`, else
`blackboards-<id>`); the board list has its own (`blackboards-boards`).

### Theme

The theme part turns the active theme item (type `theme`, most recently
changed wins) into CSS variables. Plugins use only these tokens:

`--bg --surface --text --text-muted --line --accent-here --accent-attention
--accent-agent --link --font --font-mono --font-size --radius`

The default is black with white and grey; the three accents are rare and
never carry meaning by colour alone (the current thread also has a bar, the
agent's working state a spinner and words, errors a "!" and words).

## Plugins in v1

- `settings` - the Settings modality: CSS variables from the active theme
  item, feature switches and the deletion setting.
- `agent-hermes` - service `agent` over a Hermes API server: one Hermes
  session per thread, background runs followed through their event stream,
  resumed after a kernel restart; images are sent as vision input, small
  text files are inlined, and every attachment is listed with a loopback
  download URL (`filesUrl`, default `http://127.0.0.1:8180/k/files`) so the
  agent can open PDFs, documents, archives and audio with its own tools.
- `transcribe-http` - service `transcribe` over an HTTP speech-to-text
  endpoint.
- `chat` - threads (newest first), each a fresh agent session; text, voice
  messages with a live level meter (transcribed on the server, then sent),
  files and images (any type, up to 50 MB) by paste (Ctrl+V), drag and drop
  or the picker; images show as thumbnails, other files as chips. Keys: Alt+N new
  thread, Alt+T thread list, Alt+V voice, Enter sends (Shift+Enter newline).
  Two bar targets: the open thread (the default on PC) and the thread list.
  Input from the list acts on the list: it goes to the list's own history
  thread (`view: "threads"`, made once by `POST /p/chat/views/threads/thread`,
  never listed) with `from: "thread list"` and, as `context` for the agent
  only, the threads on screen and the archived ones (id, title, last
  updated) plus the list's commands. The reply is one short sentence and
  `@open <id>`, `@rename <id> <title>`, `@hide <id>`, `@unhide <id>` lines;
  the server moves those into the reply's `actions`, the page that asked
  runs them and saves `actionsDone`. The embedded chat between the list and
  the bar shows that conversation. Collapsed it is one line: the last answer
  (or spinner and time while it works; pink edge on a new answer) and the
  next-thread icon. Tap or drag it open: a header ("Thread list
  conversation", fold, open as a full thread, next thread) over the whole
  conversation, any height (remembered). Hide is an archive
  (`PATCH /p/chat/threads/:id {hidden}`, `GET /p/chat/threads?hidden=1`);
  nothing is deleted.
- `talk` - hands-free voice turns (end of speech detected in the page,
  fast transcription, reply spoken sentence by sentence via `tools/speak`).
- `blackboards` - pannable, zoomable boards of windows into other views,
  notes and files.
- `columns` - named columns of foldable panels, one per topic.
- `projects` - a project list (config `plugins.projects.list`), each a
  dashboard page (trial).
- `tinder` - the agent suggests tasks as a card stack; swipe right queues a
  Kanban card (needs a Kanban HTTP endpoint, see `docs/AGENTS.md`).
- `people` - person-to-person chat with other people's Sleipnyr 2
  instances (trial): signed server-to-server messages, queued while the
  other side is offline, no agent involved. Pairing: `docs/PEERS.md`.
- `next-thread` - a bent-arrow icon (top right) in the thread bar: a new thread from the open
  one, Clear (empty) or Continue (the old thread stays visible above it).
  Always a fresh agent session, even while the old thread's run is busy.
  The same icon sits in the embedded chat: the new thread becomes
  the list's conversation; the old one moves into the thread list (kept).

## Configuration

Everything specific to one installation lives in the config file (see
`config.example.json`): listen address, data folder, app name, the user's
name (`user.name`) and how the agent is called (`app.agentName`; both are
used in the UI and in the prompts sent to the agent), the enabled plugins
and their settings (agent URLs, the environment variable holding each
agent's key, the transcription URL, Task Tinder's model tiers and card
rules, the project list). Secrets are never in the config, only the names
of environment variables that hold them. Every key is described in
`docs/AGENTS.md`.

## Development

```
tests/check.sh         type check (tsc) + unit tests (bun test)
deploy/deploy.sh       check, copy HEAD to a release folder, switch, restart, health check
deploy/deploy.sh rollback
```
