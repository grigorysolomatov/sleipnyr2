# Installing Sleipnyr 2

This guide installs Sleipnyr 2 on one Linux server you own, reachable from
your phone and PC over Tailscale with HTTPS. Two paths: a generic Linux
server (systemd) and NixOS (a module in `deploy/nixos/`).

What runs where:

```
browser (phone/PC) --HTTPS--> tailscale serve --> Sleipnyr 2 (bun, :8180)
                                                    |-> Hermes API server (:8642)  agent turns
                                                    |-> transcribe sidecar (:8181) voice -> text   (optional)
                                                    |-> speak sidecar (:8182)      text -> voice   (optional)
                                                    |-> Kanban HTTP (:9120)        Task Tinder     (optional)
```

Everything except the browser listens on 127.0.0.1 only.

## 1. Generic Linux server

### Requirements

- [Bun](https://bun.sh) 1.3 or newer (`curl -fsSL https://bun.sh/install | bash`).
- git, curl.
- For voice messages: Python 3.11+, ffmpeg.
- For HTTPS on your devices: [Tailscale](https://tailscale.com) on the
  server and on each device, logged into the same tailnet.
- An agent: a [Hermes Agent](https://hermes-agent.nousresearch.com/docs)
  with its API server enabled (see section 3).

### Get the code and try it

```
sudo useradd --system --create-home --home-dir /var/lib/sleipnyr2 sleipnyr2
sudo -u sleipnyr2 git clone https://github.com/grigorysolomatov/sleipnyr2.git /var/lib/sleipnyr2/app
cd /var/lib/sleipnyr2/app
sudo -u sleipnyr2 bun install
sudo -u sleipnyr2 cp config.example.json config.json
```

Edit `config.json` (every key is described in `docs/AGENTS.md`). At least:

- `user.name`: your name, as the UI and the agent prompts use it.
- `app.agentName`: what the agent is called in the UI ("Message <name>").
- `plugins.agent-hermes.agents[0].url`: your Hermes API server.
- `dataDir`: keep `data` (relative to the repo) or an absolute path.

Remove plugin sections you do not want (a plugin runs only if its id is a
key under `plugins`). `theme`, `agent-hermes`, `transcribe-http` and `chat`
are the core set; `chat` needs the `agent` and `transcribe` services, so
keep `agent-hermes` and `transcribe-http` even if the transcriber is not
running yet (voice messages then fail with a clear error, text works).

Keys go in an environment file, never in the config:

```
sudo install -m 600 -o sleipnyr2 /dev/null /var/lib/sleipnyr2/sleipnyr2.env
sudoedit /var/lib/sleipnyr2/sleipnyr2.env
```

```
HERMES_API_KEY=<the Hermes API server key>
SLEIPNYR2_MCP_KEY=<a long random string, see docs/AGENTS.md>
KANBAN_PROXY_KEY=<only if you use Task Tinder>
AGENT_FILES_KEY=<only if you run an agent file service>
```

A random key: `openssl rand -hex 32`.

Start it once by hand:

```
cd /var/lib/sleipnyr2/app
sudo -u sleipnyr2 env $(sudo cat /var/lib/sleipnyr2/sleipnyr2.env | xargs) bun kernel/server.ts config.json
```

Open http://127.0.0.1:8180/ on the server (or through an SSH tunnel:
`ssh -L 8180:127.0.0.1:8180 server`). You should see the thread list.

### systemd unit

`/etc/systemd/system/sleipnyr2.service`:

```
[Unit]
Description=Sleipnyr 2
After=network.target

[Service]
User=sleipnyr2
WorkingDirectory=/var/lib/sleipnyr2/app
Environment=SLEIPNYR2_CONFIG=/var/lib/sleipnyr2/app/config.json
EnvironmentFile=/var/lib/sleipnyr2/sleipnyr2.env
ExecStart=/usr/local/bin/bun kernel/server.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/sleipnyr2/app/data

[Install]
WantedBy=multi-user.target
```

Adjust the bun path (`which bun`). Then:

```
sudo mkdir -p /var/lib/sleipnyr2/app/data && sudo chown sleipnyr2 /var/lib/sleipnyr2/app/data
sudo systemctl daemon-reload
sudo systemctl enable --now sleipnyr2
curl -s http://127.0.0.1:8180/k/plugins | head -c 300
```

Updating this simple install: `git pull`, `bun install`, `tests/check.sh`,
`sudo systemctl restart sleipnyr2`. For release folders with a smoke test
and rollback, use `deploy/deploy.sh` (section 5).

### Optional: voice messages (speech-to-text sidecar)

```
sudo -u sleipnyr2 python3 -m venv /var/lib/sleipnyr2/stt
sudo -u sleipnyr2 /var/lib/sleipnyr2/stt/bin/pip install faster-whisper numpy
```

`/etc/systemd/system/sleipnyr2-transcribe.service`:

```
[Unit]
Description=Sleipnyr 2 speech-to-text
After=network.target

[Service]
User=sleipnyr2
Environment=TRANSCRIBE_MODEL=small
Environment=TRANSCRIBE_FAST_MODEL=base.en
Environment=HF_HOME=/var/lib/sleipnyr2/models
ExecStart=/var/lib/sleipnyr2/stt/bin/python /var/lib/sleipnyr2/app/tools/transcribe/transcribe.py
Restart=always

[Install]
WantedBy=multi-user.target
```

It listens on 127.0.0.1:8181 (the default `transcribe-http` URL). The model
downloads on first use. `TRANSCRIBE_PROMPT` can list names and jargon to
expect. Check: `curl -s http://127.0.0.1:8181/api/health`.

### Optional: spoken replies (text-to-speech sidecar, hands-free talk)

```
sudo -u sleipnyr2 python3 -m venv /var/lib/sleipnyr2/tts
sudo -u sleipnyr2 /var/lib/sleipnyr2/tts/bin/pip install kokoro numpy
sudo -u sleipnyr2 /var/lib/sleipnyr2/tts/bin/python -m spacy download en_core_web_sm
```

Same unit shape as above with
`ExecStart=/var/lib/sleipnyr2/tts/bin/python /var/lib/sleipnyr2/app/tools/speak/speak.py`
and `Environment=SPEAK_VOICE=am_michael` (any Kokoro voice). It listens on
127.0.0.1:8182, the `talk` plugin's default `speakUrl`.

## 2. HTTPS on your devices (Tailscale serve)

Browsers only allow the microphone and installing as an app (PWA) over
HTTPS. Tailscale gives the server a name and a certificate on your tailnet:

```
sudo tailscale up
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8180
tailscale serve status
```

Open `https://<server name>.<your tailnet>.ts.net:8443/` on your phone (with
Tailscale on) and use "Add to home screen" / "Install app". Only devices on
your tailnet can reach it. Do not use `tailscale funnel` (that would put it
on the public internet; Sleipnyr 2 has no login of its own yet). The one
exception is the separate inbox of the `people` plugin, see `docs/PEERS.md`.

## 3. Connecting a Hermes agent

Sleipnyr 2 talks to a Hermes Agent through Hermes' API server (the
OpenAI-compatible HTTP endpoint with sessions and background runs). On the
Hermes side, enable the API server on 127.0.0.1:8642 with a key (see the
Hermes docs, "API server"; the key is `API_SERVER_KEY` in Hermes' `.env`).
Put the same key in Sleipnyr's env file as `HERMES_API_KEY` and point
`plugins.agent-hermes.agents[0].url` at it.

Check from the server:

```
curl -s -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/v1/models
```

Then send a message in a new thread; the reply should stream in. Each
thread is its own Hermes session (titled `sleipnyr2 <thread title>`).

Attachments: the agent gets a `download: http://127.0.0.1:8180/k/files/<id>`
line per file and fetches it itself, so Hermes must run on the same machine
(or set `filesUrl` to an address it can reach).

Agent files back (optional): when the agent replies with a line
`MEDIA:/absolute/path`, the chat fetches that file from an "agent file
service" (`plugins.chat.agentFiles`, default http://127.0.0.1:9122, bearer
key `AGENT_FILES_KEY`, `GET /files?path=...`) and shows it inline. Without
that service the line stays as text with "(could not fetch: ...)".

Live view effects (optional): give the agent the MCP server Sleipnyr 2
exposes at `POST /k/mcp` (see `docs/AGENTS.md`, "MCP actions"). In Hermes'
`config.yaml`:

```
mcp_servers:
  sleipnyr2:
    url: http://127.0.0.1:8180/k/mcp
    headers:
      Authorization: Bearer ${SLEIPNYR2_MCP_KEY}
```

with `SLEIPNYR2_MCP_KEY` in Hermes' `.env` and the same value in
Sleipnyr's env file.

### Optional: report-back from Hermes Kanban

If your Hermes agent creates Kanban cards from a chat thread, finished cards
can report back into that thread unasked. `tools/kanban-report/kanban_report.py`
follows every board's task events (read-only) and, for completed, review,
blocked (not dependency waits) and gave-up cards, posts
`POST /p/chat/threads/<id>/notices`: the thread shows one quiet "Notice" line,
the agent runs a turn with the full text and reports in its own voice, and the
thread is bold (unread) in the list until opened.

The origin thread is inferred from the Hermes session that created the card
(session id `sleipnyr2-<thread id>-...`, the agent-hermes prefix). Override with
a line in the card body:

```
origin: sleipnyr2:<thread id>
```

or `kanban_report.py watch <board> <card> <thread>`. On NixOS:

```
services.sleipnyr2.kanbanReport = {
  enable = true;
  user = "hermes-user";                # account that runs Hermes
  hermesHome = "/home/hermes-user/.hermes";
};
```

Elsewhere run the script as a service with `KR_BOARDS`, `KR_STATE_DB`,
`KR_STATE_DIR`, `KR_APP` (see its docstring). First start has no backlog.

## 4. NixOS

Copy `deploy/nixos/sleipnyr2.nix` into your configuration and import it:

```nix
{
  imports = [ ./sleipnyr2.nix ];
  services.sleipnyr2 = {
    enable = true;
    tailscalePort = 8443;                 # null = loopback only
    environmentFile = "/etc/nixos/secrets/sleipnyr2.env";   # root-only, not in git
    settings = {
      app = { name = "Sleipnyr 2"; shortName = "Sleipnyr 2"; home = "chat"; agentName = "Agent"; };
      user = { id = "me"; name = "Ada"; };
      plugins = {
        theme = { };
        agent-hermes.agents = [ { id = "main"; name = "Agent"; url = "http://127.0.0.1:8642"; keyEnv = "HERMES_API_KEY"; } ];
        transcribe-http = { };
        chat.agent = "main";
        next-thread = { };
        talk = { };
        blackboards = { };
        columns = { };
      };
      actions.agents.main = { keyEnv = "SLEIPNYR2_MCP_KEY"; grants = { chat = "look"; view = "act"; }; };
    };
  };
}
```

The module runs the app plus both sidecars as a hardened `sleipnyr2` user
and, with `tailscalePort`, a `sleipnyr2-serve` unit for HTTPS. It only runs
whatever release `deploy/deploy.sh` put in
`/var/lib/sleipnyr2/releases/current` (state dir option `stateDir`), so
after `nixos-rebuild switch` run a first deploy from a clone:

```
git clone https://github.com/grigorysolomatov/sleipnyr2.git && cd sleipnyr2
bun install
deploy/deploy.sh
```

A new plugin is enabled by adding `<id> = { };` under `settings.plugins`
and rebuilding.

## 5. Deploying updates with release folders

`deploy/deploy.sh` (needs sudo) checks, copies HEAD to
`$SLEIPNYR2_HOME/releases/<sha>`, runs it as a preview on a spare port with
a copy of the data (`deploy/preview.sh`), smoke-tests it in headless
Chromium, switches `current`, restarts the unit and smoke-tests the live
app, switching back on failure. `deploy/deploy.sh rollback` returns to the
previous release. Environment: `SLEIPNYR2_HOME` (/var/lib/sleipnyr2),
`SLEIPNYR2_UNIT` (sleipnyr2), `SLEIPNYR2_URL` (http://127.0.0.1:8180),
`BUN`, `CHROMIUM` (the smoke test's browser binary), `SKIP_SMOKE=1`
(emergencies only). The unit must read its config from
`SLEIPNYR2_CONFIG` (the NixOS module does this; for the generic unit,
point `ExecStart` at `$SLEIPNYR2_HOME/releases/current/kernel/server.ts`).

## 6. Check an installation

```
tests/check.sh                                   # types, syntax, unit tests, CSS
CHROMIUM=$(which chromium) bun tests/smoke.ts http://127.0.0.1:8180   # loads at phone + desktop size, no JS errors
```

## Troubleshooting

- Blank page: `journalctl -u sleipnyr2 -e`; a plugin whose `needs` is not
  provided stops the start (keep `agent-hermes` + `transcribe-http` with
  `chat`).
- "could not open an agent session": wrong `url` or key; test with the curl
  above.
- Mic button does nothing on the phone: you opened it over http; use the
  Tailscale HTTPS address.
- After an update the page shows "New version": tap it.
