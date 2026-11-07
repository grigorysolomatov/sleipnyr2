# People: chat between two Sleipnyr 2 instances (trial)

The `people` plugin lets two people, each running their own Sleipnyr 2,
write to each other. The People modality (`/m/people`) lists the people you
have paired with. Each person opens a conversation drawn like a chat
thread. The shared bar sends text, voice messages and files.

No agent takes part. Messages are never sent to an agent. The view has no
embedded agent chat, and its messages carry no `data-k-id`, so the agent's
view tools cannot read them.

## How it works

- Each instance has its own Ed25519 key pair. The private key lives only
  in that instance's environment file. The public key is what the other
  side puts in its config.
- Sending a message means one HTTPS `POST /peer/inbox` from your server to
  the other person's server. The request is signed with your private key,
  covering the time, the path and a hash of the body. The receiver accepts
  it only if the key is in its peer list, the signature checks out and the
  time is within 5 minutes. Anything else gets 401/403 and is not stored.
- The inbox is a second, separate listener (default `127.0.0.1:8183`). It
  answers only `POST /peer/inbox`, so exposing it never exposes the app,
  its threads or its files. It starts only when a key and at least one
  peer are configured. Without them nothing changes.
- Both sides store every message as an item (`peer-message`). Attachments
  are copied over, up to 8 MB per message, and stored as files.
- If the other server is offline, messages wait in order and are retried
  every 5 s, backing off up to every 5 minutes. They also go out at once
  when that person writes to you, since their server is evidently up. A
  message the other side refuses (wrong key, too large) is marked "Not
  delivered" and waits for a tap on retry. A message delivered twice
  (after a lost answer) is stored only once.

## Reaching each other with separate tailnets

Each person keeps their own Tailscale tailnet. Two options work; the
plugin only needs a URL for each side.

1. **Tailscale Funnel on the inbox port (default, least bother).** Each
   side publishes only the inbox listener on the public internet:

   ```
   sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8183
   ```

   The peer URL is then `https://<machine>.<tailnet>.ts.net:10000`. The
   first time, Tailscale asks you to allow Funnel for the machine (a link
   in the terminal; Funnel works only on ports 443, 8443 and 10000). The
   app itself stays on `tailscale serve`, tailnet only.
   - Trade-off: the inbox is reachable from anywhere, but it accepts only
     signed requests from configured keys and serves nothing else.
     Nothing in either tailnet's policy changes.

2. **Tailscale node sharing (more private, more steps).** Each side shares
   its server machine with the other person's account in the Tailscale
   admin console (Machines > ... > Share), and the other accepts the
   invite. The peer URL is then the shared machine's tailnet name, for
   example from `tailscale serve --bg --https=10000 http://127.0.0.1:8183`.
   - Trade-off: nothing is public. However, both sides have to accept
     invites, and each should restrict what the sharee can reach in their
     own policy (allow `autogroup:shared` only the inbox port). Otherwise
     the shared machine's other open ports are reachable too.

A relay server was not built. It would need a third machine that both
trust and that stays up, which is more bother than either option above.

## Pairing, step by step

Both people do steps 1 to 3 on their own server. Neither side ever sends
its private key.

1. Make a key pair, from the Sleipnyr 2 folder:

   ```
   bun plugins/people/keygen.ts
   ```

   It prints `PEOPLE_KEY=...` (private) and a public key.

2. Put the private line in the environment file the service reads (for
   example `/etc/sleipnyr2.env` or NixOS `services.sleipnyr2.environmentFile`):

   ```
   PEOPLE_KEY=<the private key from step 1>
   ```

3. Publish the inbox (Funnel or node sharing, see above) and note your URL.

4. Send the other person two values: your public key and your inbox URL,
   over any channel you both trust (a message or a call is fine, since
   these are not secrets). Check them by reading the first and last four
   characters of each key aloud: that rules out a swapped key.

5. Add the other person to your config, then restart Sleipnyr 2:

   ```json
   "people": {
     "peers": [
       { "id": "alex", "name": "Alex",
         "url": "https://<their machine>.<their tailnet>.ts.net:10000",
         "key": "<their public key>" }
     ]
   }
   ```

   On NixOS, put the same values under
   `services.sleipnyr2.settings.plugins.people`, then run
   `nixos-rebuild switch`.

6. Open People (`/m/people`), tap the person and write. "Sending…" turns
   into nothing once the message arrives. "Waiting for <name>" means their
   server is not reachable yet, and the message goes out by itself later.

To check your own side: `GET /p/people/me` shows your name, your public key
and whether the inbox is on (`ready`).

## Config keys (`plugins.people`)

- `name`: how the other side sees you (default `user.name`).
- `keyEnv`: the environment variable holding the private key (default
  `PEOPLE_KEY`).
- `inbox`: `{host, port}` of the inbox listener (default `127.0.0.1:8183`).
  Keep it on loopback and publish it with Tailscale.
- `peers`: `[{id, name, url, key}]`. `id` is a short lowercase name used in
  links (`/m/people/<id>`). `url` is the peer's inbox base URL. `key` is the
  peer's public key.

## Not built yet (kept open)

- Invoking an agent in a person-to-person conversation on purpose, for
  example "put this in our shared calendar". This would be an explicit,
  visible per-message action, never the default.
- A guaranteed agent-free mode for sensitive content, shown in the UI and
  enforced on the server.
- Group conversations, read receipts, typing indicators, editing and
  deleting, key rotation from the UI.
