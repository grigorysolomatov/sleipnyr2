# What the agent can do on screen

An audit of the things a user does by hand in each view, and whether an agent
can do the same through the actions system: MCP at `POST /k/mcp`, audited in
`GET /k/actions`, ended by the stop control. Grants are `view` and `chat` at
the "look" or "act" level. The other route is reply `@lines` in a view's own
conversation (HCP). Those run on the page that sent the turn; a reply to a
notice (a turn started by a local service) runs when that view is next on
screen. Failed or unrun lines are reported to the agent in its next turn.

Tool names below use the MCP form, `<plugin>_<name>`, so `view_media_play`
is the action `view/media_play`.

## Generic, every view (`view_*`)

Every addressable element carries `data-k-id` and `data-k-kind`. The optional
`view` argument opens that view first (e.g. `columns/<board id>`).

- view_describe (read): lists the items on screen with their ids. Items that
  hold audio are marked "player: view_media_play".
- view_mark / view_animate (look): point at an item, or a bounded effect over
  whitelisted properties.
- view_scroll_to / view_focus (look): bring an item into view or to the front.
- view_order (act): reorder Columns panels, swap Blackboards windows.
- view_media_play (act): play the audio in a message, panel or window, as a
  tap on play would. `from_s` / `to_s` set a stretch, `loop` repeats it, and
  `index` picks the n-th player on a series page. Other audio pauses. A folded
  panel or window is unfolded first.
  - If the page has had no tap yet, the browser blocks sound. A pink Play
    prompt then shows at the player, and the call answers "waiting for a
    tap". It plays once the user taps.
  - The call ends when the stretch ends, the user pauses, or on stop.
- view_media_pause (look): pause one item's players, or everything playing.
- view_media_seek (look): move a player's position and keep its play state.
- view_open (act): what a tap on an item does. Examples: a thread in the list
  (switch thread), a project, a board in a board list, a modality in the picker.
- view_back (act): the view's back arrow. Thread goes to list, board to board
  list, modality to picker.
- view_fold (act): fold or unfold a Columns panel or a Blackboards window
  (saved in the board), or the embedded chat (`target: "strip"`).

When several pages are open, the page touched most recently runs open, back
and media. Phone and desktop never both play.

## Chat-specific (`chat_*`)

- chat_blink, chat_glow, chat_highlight, chat_select: effects on list rows.
- chat_mark: a message part (voice, time, name, text, transcript, attachment).
- chat_scroll: scroll a thread, the list or the embedded chat.
- chat_reply_open: unfold the embedded chat with the latest reply.

## Per view: user interactions and their agent route

Legend: yes = agent action exists; HCP = only as a reply @line in that view's
own conversation; no = not yet.

### Chat thread
- Play / pause / seek a voice message or audio attachment: yes (view_media_*)
- Scroll the log, jump to latest: yes (chat_scroll, view_scroll_to)
- Back to the thread list: yes (view_back)
- Open an image or file attachment in a new tab: no (it leaves the app; the
  agent can point at it with chat_mark)
- Download a voice message: no (a file save on the user's device)
- Copy a code block: no (the clipboard belongs to the user)
- Rename the thread (tap title): no
- Next thread (bent arrow): no (a new thread; the agent asks first)
- Stop / queue a running turn: no (the agent's own turn)

### Embedded chat strip (under every non-chat view)
- Fold / unfold: yes (view_fold target strip, chat_reply_open)
- Play voice inside it: yes (view_media_play with the message id)
- Scroll: yes (chat_scroll view embedded)
- Drag to resize the height: no
- Threads menu: switch the strip's thread: no

### Thread list
- Open a thread: yes (view_open with the thread id, HCP @open)
- Rename / hide / unhide: HCP (@rename/@hide/@unhide)
- Archived threads: listed in the list conversation; unhide via HCP @unhide
- New thread (+): no (creating content stays with the user or the agent's own API)
- Select / blink / mark rows: yes (chat_*)

### Modality picker (/m)
- Open a modality: yes (view_open with its id)

### Columns
- Fold / unfold a panel: yes (view_fold, HCP @collapse/@expand)
- Play audio in a panel (series pages): yes (view_media_play, `index`)
- Reorder panels / move to another column: yes (view_order, HCP @move)
- Scroll to a column or panel: yes (view_scroll_to, view_focus)
- Open a board from the board list: yes (view_open); back to the list: yes (view_back)
- Archived boards section (board list): yes (view_fold / view_open target `archived`)
- Rename board/column, add/close panels, notes: HCP
- Suggested tasks with Dismiss / Comment / Accept: HCP @suggest, @decide

### Blackboards
- Fold / unfold a window: yes (view_fold, HCP @collapse/@expand)
- Play audio in a window: yes (view_media_play)
- Bring a window forward / pan to it: yes (view_focus, HCP @focus/@fit)
- Swap windows: yes (view_order); free move: HCP @move
- Zones: HCP (@zone/@unzone); open a board: yes (view_open); back: yes (view_back)
- Pinch zoom / pan the board: no (view_focus covers "show me X")

### Task Tinder
- Accept / reject the top card: no (it creates or drops a Kanban card; the
  agent uses the Tinder API with the user's OK)
- Back: yes (view_back)

### Projects
- Open a project: yes (view_open); back: yes (view_back)

### Theme, Balance
- Change a token: HCP in Theme (@set/@reset)
- Feature switches: no (server settings API, not a page action)
- Balance rows: read only; view_describe and view_mark cover them

### Talk (hands-free) and People
- Start / stop hands-free talk: no (needs the user's microphone)
- Play a spoken reply again: yes (view_media_play on the message)
- People threads: same chat actions as a thread; no agent takes part by default

## @line reference (view conversations)

A view's own conversation (HCP) turns reply lines `@verb args` into actions
that the page runs. The prompt each view sends lists its verbs; this table
is the same list in one place. A body (`@note`, `@edit`) is the following
lines up to a line `@end`. Results come back to the agent in its next turn
("ok ..." / "failed ...").

Thread list (/):
- `@open <thread id>`: open that thread
- `@rename <thread id> <title>`: rename it
- `@hide <thread id>` / `@unhide <thread id>`: archive or restore (nothing
  is deleted)

Modality picker (/m):
- `@open <modality id>`: show that modality

Projects (/m/projects):
- `@open <project id>`: show that project's dashboard; `@back`: the list

Theme (/m/theme):
- `@set <token> <value>`: colours #rrggbb, radius and font size in px
- `@reset <token>` / `@reset all`

Task Tinder (/m/tinder):
- `@suggest <board> | <tier> | <cost> | <title>`: a new suggestion card

Columns, board list (/m/columns):
- `@open`, `@new [title]`, `@rename <board id> <title>`, `@hide`, `@unhide`

Columns, one board (/m/columns/<id>):
- columns: `@column <title>`, `@rename-column <column> <title>`,
  `@move-column <column> <position>`, `@remove-column <column>` (empty
  only), `@show <column>`
- panels: `@note <column> <title>` + body, `@edit <panel>` + body,
  `@add <column> thread|threads|tinder|projects|file|url ...`,
  `@move <panel> <column> [position]`, `@close <panel>`,
  `@title <panel> <name>`, `@collapse` / `@fold`, `@expand` / `@unfold`
- marks: `@focus <panel>`, `@highlight <panel or column> [why]`,
  `@new <panel> [why]` / `@unnew <panel>`
- decisions: `@suggest <column> [board=<kanban board>] <title>`,
  `@decide <panel> [kanban board]` (Dismiss / Comment / Accept)
- board: `@rename-board <title>`, `@memo <text>`, `@memo-clear`, `@back`

Blackboards, list (/m/blackboards):
- `@open`, `@new <title>`, `@rename <id> <title>`, `@hide`, `@unhide`

Blackboards, one board (/m/blackboards/<id>):
- windows: `@note <title>` + body, `@edit <window>` + body,
  `@add thread|threads|tinder|projects|file|url ...`,
  `@move <window> <x> <y> [<w> <h>]` (24 px grid), `@close <window>`,
  `@title <window> <name>`, `@collapse` / `@fold`, `@expand` / `@unfold`
- marks: `@focus <window>`, `@highlight <window> [why]`, `@unhighlight`,
  `@new <window> [why]` / `@unnew <window>`
- layout: `@zone <title> <x> <y> <w> <h>`, `@unzone <title>`,
  `@arrange [zone]`, `@fit`
- board: `@rename <title>`, `@memo [window] <text>`,
  `@memo-clear [window]`, `@back`

Columns windows are panels in columns (positions); Blackboards windows sit
at x/y on a plane. The two vocabularies differ on purpose where the layouts
differ (`@move`, `@zone`, `@arrange`).

## Not offered on purpose

These are left out on purpose: the clipboard, downloads, the microphone and
camera, file pickers, deleting anything, and sending messages as the user.
They act on the user's device or speak for the user.
