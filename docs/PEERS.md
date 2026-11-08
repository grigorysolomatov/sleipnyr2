# People: chat between two Sleipnyr 2 instances (trial)

The `people` plugin lets two people, each running their own Sleipnyr 2,
write to each other. The People modality (`/m/people`) lists the people you
have paired with. Each person opens a conversation drawn like a chat
thread. The shared bar sends text, voice messages and files.

No agent takes part. Messages are never sent to an agent. The view has no
embedded agent chat, and its messages carry no `data-k-id`, so the agent's
view tools cannot read them. Invite codes and keys never pass through an
agent either.

## Pairing in short

One person sends one code; the other pastes it. Nothing to edit, no restart.

1. **Once per server: publish the inbox.** The inbox is a small separate
   listener that only takes signed messages. Publish it with Tailscale
   Funnel (the app itself stays tailnet-only):

   ```
   sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8183
   ```

   The first time, Tailscale prints a link to allow Funnel for the
   machine: open it and approve. Your inbox address is then
   `https://<machine>.<tailnet>.ts.net:10000` (the People view shows the
   exact command for your inbox port).

2. **Once per server: tell People that address.** Open People, tap the
   person-plus (Invite) or the ticket (Accept invite), paste the address
   and Save. Or set `plugins.people.publicUrl` in the config. Under the
   list, "Your inbox" then says whether it answers from outside, and if
   not, shows the command again.

3. **Invite.** One person taps the person-plus: the popover shows a code
   (`sleipnyr-invite-...`) with a copy button. Send it over any channel
   (message, email). It works once, for 7 days, and holds no secret: only
   your name, your inbox address, your public key and a one-time token.

4. **Accept.** The other person taps the ticket, pastes the code (the rest
   of the message around it does not matter) and taps Pair. Both lists
   show each other at once.

5. **Optional: compare the safety code.** Both screens show the same six
   digits (in the popover after pairing, and at the top of the
   conversation). Read them to each other by phone once. If they match,
   nobody swapped a key in between.

The first Invite or Accept makes this server's key. It is kept in
`<dataDir>/private/people/key` (mode 0600), never in an item, a file, the
API or git. Back up `dataDir` as usual; losing the key means pairing again.

## How it works

- Each instance has its own Ed25519 key pair. A `PEOPLE_KEY` environment
  variable (base64 PKCS#8, `bun plugins/people/keygen.ts`) still wins over
  the key file if set.
- Sending a message means one HTTPS `POST /peer/inbox` from your server to
  the other person's server. The request is signed with your private key,
  covering the time, the path and a hash of the body. The receiver accepts
  it only if the key belongs to a paired person, the signature checks out
  and the time is within 5 minutes. Anything else gets 401/403 and is not
  stored.
- Pairing: the accepting server sends `POST /peer/pair` to the inviter's
  inbox, signed with its own key, carrying the token, its name, inbox
  address and public key. The inviter's server checks that the token is
  one it issued (stored only as a hash), unused and not expired, and that
  the request is signed by the key it names. It then adds that person
  (`<dataDir>/private/people/peers.json`), marks the token used and
  answers, signed with its own key. The accepting server only adds the
  inviter if that answer is signed by the key in the invite. An unknown,
  used or expired token gets 403; a bad signature 401.
- The inbox is a second, separate listener (default `127.0.0.1:8183`). It
  answers only `POST /peer/inbox`, `POST /peer/pair` and `GET /peer/ping`
  (the public key, for the reachability check), so exposing it never
  exposes the app, its threads or its files. It starts as soon as a key
  exists.
- Both sides store every message as an item (`peer-message`). Attachments
  are copied over, up to 8 MB per message, and stored as files.
- If the other server is offline, messages wait in order and are retried
  every 5 s, backing off up to every 5 minutes. They also go out at once
  when that person writes to you. A message the other side refuses (wrong
  key, too large) is marked "Not delivered" and waits for a tap on retry.
  A message delivered twice (after a lost answer) is stored only once.

## Reaching each other with separate tailnets

Each person keeps their own Tailscale tailnet.

1. **Tailscale Funnel on the inbox port (default).** As above. Funnel
   works only on ports 443, 8443 and 10000; 10000 keeps 443/8443 free for
   the app's `tailscale serve`. The inbox is reachable from anywhere, but
   it accepts only signed requests from paired keys (and pairing requests
   with a valid token) and serves nothing else.

2. **Tailscale node sharing (more private, more steps).** Each side shares
   its server machine with the other person's account in the Tailscale
   admin console (Machines > ... > Share), and the other accepts. Publish
   the inbox with `tailscale serve --bg --https=10000 http://127.0.0.1:8183`
   and use the tailnet name as the inbox address. Nothing is public, but
   both sides should restrict what the sharee can reach in their own
   policy (allow `autogroup:shared` only the inbox port).

## Pairing by hand (config)

Still supported, for example to pin people in a NixOS config. Make a key
(`bun plugins/people/keygen.ts`, put `PEOPLE_KEY=...` in the environment
file), exchange public keys (`GET /p/people/me`) and inbox addresses, add:

```json
"people": {
  "peers": [
    { "id": "alex", "name": "Alex",
      "url": "https://<their machine>.<their tailnet>.ts.net:10000",
      "key": "<their public key>" }
  ]
}
```

and restart. Config people and invited people are merged; a key in both is
listed once.

## Config keys (`plugins.people`)

- `name`: how the other side sees you (default `user.name`).
- `publicUrl`: your inbox address as others reach it. Optional: if unset,
  it is set once in the People view.
- `inbox`: `{host, port}` of the inbox listener (default `127.0.0.1:8183`).
  Keep it on loopback and publish it with Tailscale.
- `keyEnv`: an environment variable holding the private key (default
  `PEOPLE_KEY`). Optional: without it the key file is used.
- `peers`: `[{id, name, url, key}]`, people paired by hand. Optional.

## Not built yet (kept open)

- Removing a person or rotating the key from the UI (today: edit
  `<dataDir>/private/people/peers.json` or delete `key` and pair again).
- Invoking an agent in a person-to-person conversation on purpose, for
  example "put this in our shared calendar". This would be an explicit,
  visible per-message action, never the default.
- A guaranteed agent-free mode for sensitive content, shown in the UI and
  enforced on the server.
- Group conversations, read receipts, typing indicators, editing and
  deleting.
