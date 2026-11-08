#!/usr/bin/env python3
"""Kanban report bridge: finished cards report back into the chat thread that started them.

A chat thread talks to a Hermes agent through its API server, one Hermes session per thread
(session id "<prefix><thread id>-<hash>", prefix "sleipnyr2-" by default). When the agent creates
a Kanban card in that session, the card's outcome must come back to the same thread unasked.
Hermes' own notify subscriptions only reach gateway platforms, so this service closes the gap:

  every POLL seconds, for every board, read new task_events (cursor per board in STATE_DIR);
  for a terminal event (completed, review requested, blocked except dependency waits, gave up)
  find the card's origin thread:
    1. an explicit subscription (`kanban_report.py watch <board> <card> <thread>`, kept in
       STATE_DIR/watch.json),
    2. a body line "origin: sleipnyr2:<thread id>",
    3. the Hermes session whose tool output created the card ("Created t_x", --json output, or
       kanban_create's task_id) in Hermes' state.db, when its id carries the session prefix,
    4. the same for the card that created it, up to 3 levels;
  and post a notice into that thread (POST <app>/p/chat/threads/<id>/notices). The app shows one
  quiet line ("Card t_x done: title") and runs a real agent turn with the full text, so the agent
  reports the result in its own voice; the reply marks the thread unread.
Idempotent: every notice carries a key (board, card, event id); the app ignores repeats.
On first start the cursors begin at the newest event: no backlog flood.

Stdlib only, read-only on Kanban and state.db.
  kanban_report.py              run the loop
  kanban_report.py --once       one pass
  kanban_report.py --dry-run    print what would be posted (cursors untouched)
  kanban_report.py watch <board> <card> <thread>    subscribe a card explicitly
  kanban_report.py origin <board> <card>            print the thread a card would report to
Config (environment): KR_BOARDS (Hermes kanban boards dir), KR_STATE_DB (Hermes state.db),
KR_STATE_DIR, KR_APP (app URL), KR_PREFIX (session id prefix), KR_POLL (s), KR_ORIGIN_TAG.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
BOARDS = os.environ.get("KR_BOARDS", os.path.join(HOME, ".hermes/kanban/boards"))
STATE_DB = os.environ.get("KR_STATE_DB", os.path.join(HOME, ".hermes/state.db"))
STATE_DIR = os.environ.get("KR_STATE_DIR", os.path.join(HOME, ".local/state/sleipnyr2-kanban-report"))
APP = os.environ.get("KR_APP", "http://127.0.0.1:8180").rstrip("/")
PREFIX = os.environ.get("KR_PREFIX", "sleipnyr2-")
TAG = os.environ.get("KR_ORIGIN_TAG", "sleipnyr2")
POLL = int(os.environ.get("KR_POLL", "20"))
KINDS = ("completed", "review_requested", "blocked", "gave_up")
TID = re.compile(r"^t_[0-9a-f]{6,16}$")
THREAD = re.compile(r"^t_[0-9a-f]{6,16}$")  # chat thread item ids look like card ids; different stores
# Blocks the user ordered (pause/park/stop) are not news for him.
PAUSE = re.compile(r"^\W*(paused|parked|held|on hold|stopped by|cancelled by|superseded)\b", re.I)
WORD = {"completed": "done", "review_requested": "ready for review", "blocked": "blocked", "gave_up": "failed"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)


def boards():
    out = []
    if not os.path.isdir(BOARDS):
        return out
    for slug in sorted(os.listdir(BOARDS)):
        db = os.path.join(BOARDS, slug, "kanban.db")
        if slug.startswith("_") or os.path.islink(os.path.join(BOARDS, slug)) or not os.path.exists(db):
            continue  # symlinks are old-slug aliases; archived boards still count (a card can finish there)
        out.append((slug, db))
    return out


# --- state -------------------------------------------------------------------------------------------------------
def load(name, default):
    try:
        with open(os.path.join(STATE_DIR, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, data):
    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, name)
    with open(path + ".tmp", "w") as f:
        json.dump(data, f, indent=1)
    os.replace(path + ".tmp", path)


# --- card -> thread ----------------------------------------------------------------------------------------------
def thread_of_session(sid):
    sid = str(sid or "")
    if not sid.startswith(PREFIX):
        return None
    m = re.match(r"^(t_[0-9a-f]{6,16})-", sid[len(PREFIX):])
    return m.group(1) if m else None


def thread_from_sessions(tid):
    """The thread whose agent session first showed the card being created."""
    if not TID.match(tid) or not os.path.exists(STATE_DB):
        return None
    con = ro(STATE_DB)
    try:
        row = con.execute(
            "SELECT session_id FROM messages WHERE role='tool' AND ("
            " content LIKE ? OR content LIKE ? OR content LIKE ? OR (tool_name='kanban_create' AND content LIKE ?))"
            " ORDER BY id LIMIT 1",
            (f"%Created {tid} %", f'%\\"id\\": \\"{tid}\\"%', f'%"id": "{tid}"%', f'%"task_id": "{tid}"%')).fetchone()
        return thread_of_session(row[0]) if row else None
    finally:
        con.close()


CACHE = {}  # "board/card" -> thread or "" (a card's origin never changes; state.db scans are slow)


def origin(con, slug, tid, watch, depth=0):
    w = watch.get(f"{slug}/{tid}")
    if w:
        return w
    k = f"{slug}/{tid}"
    if k not in CACHE:
        CACHE[k] = find_origin(con, slug, tid, watch, depth) or ""
    return CACHE[k] or None


def find_origin(con, slug, tid, watch, depth):
    r = con.execute("SELECT body FROM tasks WHERE id=?", (tid,)).fetchone()
    if r is None:
        return None
    m = re.search(r"^\s*origin:\s*" + re.escape(TAG) + r":(t_[0-9a-f]{6,16})\b", r[0] or "", re.I | re.M)
    if m:
        return m.group(1)
    t = thread_from_sessions(tid)
    if t or depth >= 3:
        return t
    ev = con.execute("SELECT payload FROM task_events WHERE task_id=? AND kind='created' ORDER BY id LIMIT 1",
                     (tid,)).fetchone()
    try:
        parent = (json.loads(ev[0]) or {}).get("creator_task_id") if ev and ev[0] else None
    except ValueError:
        parent = None
    return origin(con, slug, parent, watch, depth + 1) if parent and parent != tid else None


# --- notice ------------------------------------------------------------------------------------------------------
def first(text, limit):
    t = " ".join(str(text or "").split())
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def worker_report(con, tid):
    """The worker's final message of its latest run (from state.db), or None."""
    row = con.execute("SELECT payload FROM task_events WHERE task_id=? AND kind='owner_admitted' ORDER BY id DESC LIMIT 1",
                      (tid,)).fetchone()
    try:
        sid = json.loads(row[0]).get("session_id") if row else None
    except ValueError:
        sid = None
    if not sid or not os.path.exists(STATE_DB):
        return None
    s = ro(STATE_DB)
    try:
        r = s.execute("SELECT content FROM messages WHERE session_id=? AND role='assistant' AND length(trim(content))>0 "
                      "ORDER BY id DESC LIMIT 1", (sid,)).fetchone()
    finally:
        s.close()
    return r[0] if r and r[0] else None


def notice(con, slug, tid, kind, payload, title):
    word = WORD[kind]
    line = f"Card {tid} {word}: {first(title, 120)}"
    detail = payload.get("summary") or payload.get("result") or payload.get("reason") or payload.get("error") or ""
    rep = worker_report(con, tid) if kind in ("completed", "review_requested", "blocked") else None
    arts = [r[0] for r in con.execute("SELECT stored_path FROM task_attachments WHERE task_id=? ORDER BY id", (tid,))]
    text = (f"[Automatic notice, not a message from the user: Kanban card {tid} on board {slug} is now {word}.]\n"
            f"Title: {title}\n"
            + (f"Kind: {payload.get('kind')}\n" if kind == "blocked" and payload.get("kind") else "")
            + (f"Handoff: {first(detail, 3000)}\n" if detail else "")
            + (f"Worker's final message:\n{rep[:6000]}\n" if rep and first(rep, 200) != first(detail, 200) else "")
            + (("Attachments: " + ", ".join(arts[:12]) + "\n") if arts else "")
            + f"\nThis card was started from this conversation. Report the result to the user here now, in your "
              f"normal reply format: what was done, the deliverable (link it; show images or PDFs with MEDIA:/abs/path "
              f"lines), and whether they need to act (an exact question if so). For details: "
              f"`hermes kanban --board {slug} show {tid}`. Do not mention this notice.")
    return line, text


def post(thread, line, text, key, dry):
    if dry:
        print(f"--- would post to {thread} (key {key}): {line}\n{text}\n")
        return True
    req = urllib.request.Request(f"{APP}/p/chat/threads/{thread}/notices", method="POST",
                                 data=json.dumps({"notice": line, "text": text, "key": key}).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        log(f"{line} -> {thread} (HTTP {r.status})")
    return True


# --- loop --------------------------------------------------------------------------------------------------------
def one_pass(cursors, dry):
    watch = load("watch.json", {})
    for slug, db in boards():
        con = ro(db)
        try:
            top = con.execute("SELECT coalesce(max(id),0) FROM task_events").fetchone()[0]
            cur = cursors.get(slug)
            if cur is None:  # new board / first start: begin now, report nothing old
                cursors[slug] = top
                continue
            rows = con.execute(
                f"SELECT e.id, e.task_id, e.kind, e.payload, t.title FROM task_events e JOIN tasks t ON t.id=e.task_id "
                f"WHERE e.id>? AND e.kind IN ({','.join('?' * len(KINDS))}) ORDER BY e.id", (cur, *KINDS)).fetchall()
            done = cur
            for eid, tid, kind, payload, title in rows:
                try:
                    p = json.loads(payload) if payload else {}
                except ValueError:
                    p = {}
                skip = kind == "blocked" and (p.get("kind") == "dependency" or p.get("reason") == "initial_status"
                                              or PAUSE.search(str(p.get("reason") or "")))
                thread = None if skip else origin(con, slug, tid, watch)
                if thread and THREAD.match(thread):
                    line, text = notice(con, slug, tid, kind, p, title)
                    try:
                        post(thread, line, text, f"kanban:{slug}:{tid}:{eid}", dry)
                    except urllib.error.HTTPError as e:
                        if e.code not in (400, 404):  # thread gone or refused: drop; anything else: retry later
                            log(f"post {tid} -> {thread} failed (HTTP {e.code}); will retry")
                            break
                        log(f"post {tid} -> {thread} dropped (HTTP {e.code})")
                    except Exception as e:
                        log(f"post {tid} -> {thread} failed ({e}); will retry")
                        break
                done = eid
            else:
                done = top
            if not dry:
                cursors[slug] = done
        finally:
            con.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="*", help="watch <board> <card> <thread> | origin <board> <card>")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.cmd:
        if a.cmd[0] == "watch" and len(a.cmd) == 4:
            _, slug, tid, thread = a.cmd
            if not TID.match(tid) or not THREAD.match(thread):
                sys.exit("card and thread ids look like t_<hex>")
            w = load("watch.json", {})
            w[f"{slug}/{tid}"] = thread
            save("watch.json", w)
            print(f"{slug}/{tid} reports to {thread}")
            return
        if a.cmd[0] == "origin" and len(a.cmd) == 3:
            _, slug, tid = a.cmd
            con = ro(os.path.join(BOARDS, slug, "kanban.db"))
            try:
                print(origin(con, slug, tid, load("watch.json", {})) or "-")
            finally:
                con.close()
            return
        sys.exit(ap.format_usage())
    cursors = load("cursors.json", None)
    if cursors is None:
        cursors = {}
        one_pass(cursors, True)  # cursors only (unseen boards are skipped)
        save("cursors.json", cursors)
        log(f"initialised cursors for {len(cursors)} boards")
    while True:
        try:
            one_pass(cursors, a.dry_run)
            if not a.dry_run:
                save("cursors.json", cursors)
        except Exception as e:
            log(f"pass failed: {e}")
        if a.once or a.dry_run:
            return
        time.sleep(POLL)


if __name__ == "__main__":
    main()
