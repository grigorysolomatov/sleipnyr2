// Threads and messages with an agent.
//
// Saved items:
//   thread   {title, titleAuto?, agent, state}  state = what the agent asked to remember (its session)
//            titleAuto (default true): the title is automatic; a manual rename sets it false and nothing
//            automatic touches the title again
//            hidden: archived (left out of the list, reversible; nothing is ever deleted)
//            view: the history thread of a view ("the chat underneath" it, e.g. "threads" = the thread
//            list); one per view, reused, never listed
//   message  {thread, role, text, files, voice?, transcript?, status, error?, from?, context?}
//            from = the view the message was sent from when not this thread (e.g. "thread list"),
//            context = what that view showed; it goes to the agent with the message, not shown
//            role "user" | "agent"; status "queued" | "transcribing" | "working" | "done" | "error"
//            actions (agent replies in a view thread): the reply's "@name args" lines, taken out of its
//            text, for the view to run [{name, args}]; actionsDone = what the view reported back
// Links: message -in-> thread, message -file-> file.
// Live (unsaved) events on topic "chat": {thread, message, delta?} and {thread, message, progress}.
//
// One turn per thread at a time; later messages wait their turn. A turn that
// was running when the kernel stopped is resumed on start.
//
// Config (plugins.chat): agent = id of the default agent;
//   agentFiles = { url, keyEnv } of the read-only agent file service
//   (default http://127.0.0.1:9122, key in $AGENT_FILES_KEY). Reply lines
//   "MEDIA:/abs/path" are fetched from it, saved as files of the reply and
//   removed from its text.
import { ITEM_TOPIC } from "../../kernel/contract.ts";
import type {
  AgentService, AgentTurn, AttachedFile, FileData, Item, Kernel, ServerPlugin, TranscribeService,
} from "../../kernel/contract.ts";

export interface Thread { title: string; titleAuto?: boolean; agent: string; state: Record<string, unknown>; hidden?: boolean; view?: string; unread?: boolean;
  /** view threads: where the page last showed this conversation (level, sub, name), so any device can open it */
  place?: { level: string; sub: string; name: string } }
export interface Action { name: string; args: string; body?: string }
/** A declared agent action (kernel/actions.ts) the agent called during this reply's turn. */
export interface CallNote { id: string; text: string }
export interface Message {
  thread: string; role: "user" | "agent"; text: string; files: string[];
  voice?: string; transcript?: string; reply?: string; from?: string; context?: string; actions?: Action[]; calls?: CallNote[];
  status: "queued" | "transcribing" | "working" | "done" | "error" | "stopped" | "cancelled"; error?: string;
  // stopped (agent reply): stopped by the user; skipped = it never ran. cancelled (user message): never sent.
  // steered: the user message went into the turn that was already running (its reply stays empty, hidden).
  skipped?: boolean; steered?: boolean;
  // notice: posted by a local service, not typed by the user (e.g. "Card t_1 done: title"); shown as this
  // one quiet line while the agent gets the full text. noticeKey makes a repeated post a no-op.
  notice?: string; noticeKey?: string;
}

/** One message waiting for or getting its reply. preparing = a "send now" being transcribed (the line waits). */
interface Job { threadId: string; userId: string; replyId: string; resumed: boolean; preparing?: AbortController }
/** The running turn of a thread. state = what the agent said about it this turn (for steering). */
interface Active { job: Job; ctl: AbortController; stage: "hearing" | "working"; state: Record<string, unknown>; steered: Job[] }

export const TOPIC = "chat";
const SAVE_EVERY_MS = 3000; // a streaming reply is saved this often, so a reload shows it

/** First words of the first message, as a thread title. */
export function titleFrom(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  return words.length > 48 ? words.slice(0, 47) + "…" : words || "Voice message";
}

// Thread titles: the first words of the first message are a placeholder; after the agent's reply on turns
// RETITLE_AT and every RETITLE_EVERY turns after, a one-shot call re-summarises it; the agent may rename it
// (POST /threads/:id/title). A manual rename (PATCH /threads/:id) sets titleAuto false: the user's name wins.
export const RETITLE_AT = [1, 3, 6, 10], RETITLE_EVERY = 10;
export const retitleDue = (n: number) => RETITLE_AT.includes(n) || (n > 10 && n % RETITLE_EVERY === 0);
const TITLE_MAX = 40;
/** Model/agent output -> a clean one-line title (<= 6 words, <= 40 chars), or "". */
export function cleanTitle(s: string): string {
  let t = String(s || "").split(/\r?\n/).map(x => x.trim()).find(Boolean) || "";
  t = t.replace(/^(title|thread)\s*:\s*/i, "").replace(/[`*_#>]/g, "").replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .replace(/[.。!]+$/, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX).replace(/\s+\S*$/, "") || t.slice(0, TITLE_MAX) : t;
}

/** Splits "MEDIA:/abs/path" markers (Hermes' attachments) off a reply. */
export function extractMedia(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const out = text.replace(/[ \t]*[`"']?MEDIA:\s*[`"']?(\/[^\s`"']+)[`"']?[ \t]*/g, (_m, p: string) => {
    if (!paths.includes(p)) paths.push(p);
    return "";
  }).replace(/\[\[audio_as_voice\]\]/g, "");
  if (!paths.length) return { text, paths };
  return { text: out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), paths };
}

/** One line for a logged action call, e.g. "blink target=selection times=5 · done: blinked the selection 5×". */
export function callText(c: { action: string; args?: Record<string, unknown>; status: string; note?: string }): string {
  const args = Object.entries(c.args || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" ");
  return `${c.action}${args ? " " + args : ""} · ${c.status}${c.note ? ": " + c.note : ""}`.slice(0, 240);
}

/** A view's reply: "@name args" lines are actions for the view; the rest is the short answer.
 *  An action line may carry a body: the lines after it up to a line "@end"
 *  (e.g. a note's Markdown text). Without "@end" nothing after it is taken. */
export function extractActions(text: string): { text: string; actions: Action[] } {
  const actions: Action[] = [];
  const at = (line: string) => /^[\s`*-]*@([a-z][a-z-]{0,30})\b[ \t]*(.*?)[`*]*\s*$/.exec(line);
  const lines = String(text || "").split(/\r?\n/), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = at(lines[i]);
    if (!m || m[1] === "end") { out.push(lines[i]); continue; }
    const a: Action = { name: m[1], args: m[2].trim() };
    // a body: plain lines, then "@end", before any other action line
    let j = i + 1;
    while (j < lines.length && !at(lines[j])) j++;
    if (j > i + 1 && j < lines.length && at(lines[j])![1] === "end") { a.body = lines.slice(i + 1, j).join("\n").trim(); i = j; }
    actions.push(a);
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), actions };
}

const IDS_SHOWN = 6; // earlier messages listed by id in each turn note

export function voicePrompt(user: string, transcript: string): string {
  return `[Voice message from ${user}, transcribed on the server (may contain recognition errors):]\n${transcript}`;
}

class Chat {
  private lines = new Map<string, { jobs: Job[]; active: Active | null }>(); // thread id -> its turns, one at a time
  private stopping = new AbortController();

  constructor(private k: Kernel) {}

  private get agent() { return this.k.services.get<AgentService>("agent"); }

  /** Agents with display names, for message headers. */
  agents() { return this.agent.agents(); }
  private get stt() { return this.k.services.get<TranscribeService>("transcribe"); }

  /** Saves the files named by MEDIA: lines; returns the cleaned text and file ids. */
  private async media(text: string): Promise<{ text: string; files: string[] }> {
    const { text: clean, paths } = extractMedia(text);
    const files: string[] = [], failed: string[] = [];
    if (!paths.length) return { text, files };
    const cfg = (this.k.config.agentFiles || {}) as { url?: string; keyEnv?: string };
    const url = (cfg.url || "http://127.0.0.1:9122").replace(/\/+$/, "");
    const key = process.env[cfg.keyEnv || "AGENT_FILES_KEY"] || "";
    for (const path of paths) {
      const name = path.split("/").pop() || "file";
      try {
        const r = await fetch(`${url}/files?path=${encodeURIComponent(path)}`,
          { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const mime = (r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
        files.push(this.k.files.put(name, mime, new Uint8Array(await r.arrayBuffer())).id);
      } catch (e) {
        this.k.log(`MEDIA fetch failed (${name}):`, (e as Error).message);
        failed.push(name);
      }
    }
    const note = failed.length ? `\n\n(could not fetch: ${failed.join(", ")})` : "";
    return { text: clean + note, files };
  }

  /** Sets an automatic title (placeholder, summary or the agent's rename); false when the user named it. */
  setAutoTitle(threadId: string, title: string): boolean {
    const t = this.k.items.get<Thread>(threadId);
    if (!t || t.type !== "thread" || t.data.titleAuto === false || !title || t.data.title === title) return false;
    this.k.items.update(threadId, { title });
    return true;
  }

  /** A manual rename: from now on nothing automatic touches the title. */
  rename(threadId: string, raw: string) {
    const t = this.k.items.get<Thread>(threadId);
    if (!t || t.type !== "thread") throw new HttpError(404, "no such thread");
    const title = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) throw new HttpError(400, "title required");
    return this.k.items.update<Thread>(threadId, { title, titleAuto: false });
  }

  /** PATCH /threads/:id: {title?} renames (manual), {hidden?} archives or brings back. Never deletes. */
  change(threadId: string, b: { title?: unknown; hidden?: unknown; read?: unknown }) {
    const t = this.k.items.get<Thread>(threadId);
    if (!t || t.type !== "thread") throw new HttpError(404, "no such thread");
    if (b.read === true) { if (t.data.unread) this.k.items.update<Thread>(threadId, { unread: null }); if (b.title === undefined && b.hidden === undefined) return this.k.items.get<Thread>(threadId)!; }
    if (b.title === undefined && typeof b.hidden !== "boolean") throw new HttpError(400, "title or hidden required");
    if (b.title !== undefined) this.rename(threadId, b.title as string);
    if (typeof b.hidden === "boolean") {
      if (t.data.view) throw new HttpError(400, "a view's history thread is never listed");
      this.k.items.update<Thread>(threadId, { hidden: b.hidden ? true : null });
    }
    return this.k.items.get<Thread>(threadId)!;
  }

  /** The history thread of a view ("threads" = the thread list): found or made once, then reused. */
  viewThread(view: string) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(view)) throw new HttpError(400, "bad view name");
    const found = this.k.items.list<Thread>({ type: "thread", order: "created", limit: 10000 }).find(t => t.data.view === view);
    if (found) return found;
    const agent = String(this.k.config.agent || this.agent.agents()[0]?.id || "");
    const names: Record<string, string> = { threads: "Thread list history" };
    return this.k.items.create<Thread>("thread", { title: names[view] || `${view} history`, titleAuto: false, agent, state: {}, view });
  }

  /** POST /threads/:id/title: the agent renames a thread; 409 once the user has named it. */
  agentTitle(threadId: string, raw: string) {
    const t = this.k.items.get<Thread>(threadId);
    if (!t || t.type !== "thread") throw new HttpError(404, "no such thread");
    if (t.data.titleAuto === false) throw new HttpError(409, `${this.k.user.name} named this thread; its name is kept`);
    const title = cleanTitle(raw);
    if (!title) throw new HttpError(400, "title required");
    this.setAutoTitle(threadId, title);
    return this.k.items.get<Thread>(threadId)!;
  }

  /** Per-turn note for the agent: the thread id and how to rename it (only while the name is automatic). */
  private titleGuide(t: Item<Thread>): string {
    if (t.data.titleAuto === false) return "";
    const url = String(this.k.config.apiUrl || "http://127.0.0.1:8180").replace(/\/+$/, "");
    return `\n\n[Sleipnyr thread ${t.id}, named "${t.data.title}" (automatic; re-summarised now and then). If the topic has clearly `
      + `shifted, you may rename it (<= 6 words): curl -s -X POST ${url}/p/chat/threads/${t.id}/title -H 'content-type: application/json' `
      + `-d '{"title":"..."}'. ${this.k.user.name}'s own renames always win (the call then answers 409). Do not mention this note.]`;
  }

  /**
   * Per-turn note: the ids of the latest messages, so the agent can point at
   * one with the chat_mark / chat_scroll actions ("that voice message").
   * Not in a view's history thread (the list addresses threads, not messages).
   */
  private idsNote(t: Item<Thread>, userId: string, replyId: string): string {
    if (t.data.view) return "";
    const ms = this.messages(t.id).filter(m => m.id !== replyId && m.id !== userId).slice(-IDS_SHOWN);
    const kind = (m: Item<Message>) => [m.data.voice ? "voice" : "", m.data.files?.length ? `${m.data.files.length} file${m.data.files.length > 1 ? "s" : ""}` : ""].filter(Boolean).join("+") || "text";
    const line = (m: Item<Message>) => `${m.id} ${m.data.role === "user" ? this.k.user.name : "you"} ${kind(m)}: "${
      String(m.data.transcript || m.data.text || "").replace(/\s+/g, " ").trim().slice(0, 40)}"`;
    return `\n\n[Sleipnyr message ids, for chat_mark / chat_scroll (do not mention this note): this message ${userId}, your reply ${replyId}`
      + (ms.length ? `; earlier, oldest first: ${ms.map(line).join("; ")}` : "") + "]";
  }

  private transcriptOf(threadId: string): string {
    const ms = this.messages(threadId).filter(m => m.data.status === "done" || m.data.role === "user");
    const pick = ms.length > 22 ? [...ms.slice(0, 2), ...ms.slice(-20)] : ms;
    const line = (m: Item<Message>) => `${m.data.role === "user" ? this.k.user.name : "Agent"}: ${
      String(m.data.transcript || m.data.text || (m.data.voice ? "(voice message)" : "(files)")).replace(/\s+/g, " ").trim().slice(0, 400)}`;
    return ("Conversation so far:\n" + pick.map(line).join("\n")).slice(-8000);
  }

  private retitling = new Set<string>();
  /** After an agent reply: on a due turn, re-summarise an automatic title (fire and forget; failures are only logged). */
  private maybeRetitle(threadId: string) {
    const t = this.k.items.get<Thread>(threadId);
    if (!t || t.data.titleAuto === false || this.retitling.has(threadId) || !this.agent.title) return;
    const n = this.messages(threadId).filter(m => m.data.role === "agent" && m.data.status === "done").length;
    if (!retitleDue(n)) return;
    this.retitling.add(threadId);
    this.agent.title(t.data.agent, this.transcriptOf(threadId), AbortSignal.timeout(120000))
      .then(raw => { const c = cleanTitle(raw); if (c) this.setAutoTitle(threadId, c); }) // setAutoTitle re-checks: a manual rename meanwhile wins
      .catch(e => this.k.log("retitle failed:", (e as Error).message))
      .finally(() => this.retitling.delete(threadId));
  }

  /** The list: not hidden, not a view's history; hidden = only the hidden ones. */
  threads(hidden = false) {
    return this.k.items.list<Thread>({ type: "thread", order: "-updated", limit: 1000 })
      .filter(t => !t.data.view && !!t.data.hidden === hidden).slice(0, 500);
  }
  /** Recent conversations across all views: threads and view histories, newest
   *  message first, with its last line. Hidden (archived) threads stay out. */
  recent(limit = 30) {
    const last = new Map<string, Item<Message>>();
    for (const m of this.k.items.list<Message>({ type: "message", order: "-updated", limit: 3000 })) {
      if (!last.has(m.data.thread)) last.set(m.data.thread, m);
      if (last.size >= limit * 2) break;
    }
    const out: { id: string; view: string; title: string; role: string; text: string; status: string; updated: number; place?: Thread["place"] }[] = [];
    for (const [id, m] of last) {
      const t = this.k.items.get<Thread>(id);
      if (!t || t.data.hidden) continue;
      const text = String(m.data.text || m.data.transcript || "").replace(/\s+/g, " ").trim().slice(0, 200);
      out.push({ id, view: t.data.view || "", title: t.data.title, role: m.data.role, text, status: m.data.status, updated: Number(m.updated), place: t.data.place });
      if (out.length >= limit) break;
    }
    return out;
  }
  messages(thread: string) { return this.k.items.list<Message>({ type: "message", linkedTo: { rel: "in", to: thread }, order: "created" }); }

  newThread(title = "New thread") {
    const agent = String(this.k.config.agent || this.agent.agents()[0]?.id || "");
    return this.k.items.create<Thread>("thread", { title, agent, state: {} });
  }

  /**
   * POST /threads/:id/notices: a local service (e.g. the Kanban report bridge) starts an agent turn in a
   * thread without a user message: text goes to the agent, notice is the one line shown. The same key twice
   * returns the first post. The reply marks the thread unread.
   */
  notify(threadId: string, b: { text?: unknown; notice?: unknown; key?: unknown }) {
    const t = this.k.items.get<Thread>(threadId);
    if (!t || t.type !== "thread") throw new HttpError(404, "no such thread");
    const text = String(b.text ?? "").slice(0, 20000), notice = String(b.notice ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const key = String(b.key ?? "").slice(0, 120);
    if (!text.trim() || !notice) throw new HttpError(400, "text and notice required");
    if (key) {
      const old = this.messages(threadId).find(m => m.data.noticeKey === key);
      if (old) return { user: old, reply: old.data.reply ? this.k.items.get<Message>(old.data.reply) : null, repeated: true };
    }
    const out = this.post(threadId, text, [], undefined, undefined, "queue", { notice, ...(key ? { noticeKey: key } : {}) });
    if (t.data.hidden) this.k.items.update<Thread>(threadId, { hidden: null }); // archived threads come back for news
    return out;
  }

  /** Saves the user's message and a placeholder reply, then runs the turn in the background. */
  /** view.transcript: the voice was already transcribed (hands-free talk mode), so the turn skips hearing. */
  post(threadId: string, text: string, files: string[], voice?: string, view?: { from?: string; context?: string; transcript?: string }, mode = "queue", extra: Partial<Message> = {}) {
    if (mode !== "queue" && mode !== "now") throw new Error("mode must be queue or now");
    const thread = this.k.items.get<Thread>(threadId);
    if (!thread || thread.type !== "thread") throw new Error("no such thread");
    for (const f of [...files, ...(voice ? [voice] : [])])
      if (this.k.items.get(f)?.type !== "file") throw new Error(`no such file ${f}`);
    if (!text.trim() && !files.length && !voice) throw new Error("empty message");
    const heard = voice && typeof view?.transcript === "string" ? view.transcript.slice(0, 20000) : undefined;
    if (!this.messages(threadId).length) this.setAutoTitle(threadId, titleFrom(text || heard || ""));
    const from = String(view?.from || "").slice(0, 60), context = String(view?.context || "").slice(0, 20000);
    const user = this.k.items.create<Message>("message", { thread: threadId, role: "user", text, files, voice,
      status: voice && heard === undefined ? "transcribing" : "done", ...(heard !== undefined ? { transcript: heard } : {}),
      ...(from ? { from } : {}), ...(context ? { context } : {}), ...extra });
    const reply = this.k.items.create<Message>("message", { thread: threadId, role: "agent", text: "", files: [], status: "queued" });
    this.k.items.update(user.id, { reply: reply.id });
    this.k.links.add(user.id, "in", threadId);
    this.k.links.add(reply.id, "in", threadId);
    for (const f of [...files, ...(voice ? [voice] : [])]) this.k.links.add(user.id, "file", f);
    const job: Job = { threadId, userId: user.id, replyId: reply.id, resumed: false };
    if (mode === "now") this.sendNow(job).catch(e => this.k.log("send now failed:", e)); else this.enqueue(job);
    return { user: this.k.items.get<Message>(user.id)!, reply };
  }

  private line(threadId: string) {
    let l = this.lines.get(threadId);
    if (!l) this.lines.set(threadId, l = { jobs: [], active: null });
    return l;
  }
  private enqueue(job: Job, front = false) {
    const l = this.line(job.threadId);
    if (front) l.jobs.unshift(job); else l.jobs.push(job);
    this.pump(job.threadId);
  }
  private drop(job: Job) { const l = this.line(job.threadId); l.jobs = l.jobs.filter(j => j !== job); }
  /** Starts the next turn of a thread when none runs. */
  private pump(threadId: string) {
    const l = this.line(threadId);
    if (this.stopping.signal.aborted || l.active || !l.jobs.length || l.jobs[0].preparing) return;
    const job = l.jobs.shift()!;
    const a: Active = { job, ctl: new AbortController(), stage: "hearing", state: {}, steered: [] };
    l.active = a;
    this.turn(job, a).catch(e => this.k.log("turn failed:", e))
      .finally(() => { if (l.active === a) l.active = null; this.pump(threadId); });
  }

  /**
   * "Send now": into the running turn if the agent takes it (steer), else the
   * running turn is stopped and this one goes next. A voice message is heard
   * first; meanwhile it holds the head of the line.
   */
  private async sendNow(job: Job) {
    const l = this.line(job.threadId), ctl = new AbortController();
    job.preparing = ctl;
    l.jobs.unshift(job);
    try {
      if (!(await this.hear(job, ctl.signal))) { this.drop(job); return; }
      const a = l.active, user = this.k.items.get<Message>(job.userId)!, thread = this.k.items.get<Thread>(job.threadId)!;
      const text = this.promptOf(user) + (user.data.context ? `\n\n${user.data.context}` : "");
      if (a && a.stage === "working" && text.trim() && !user.data.files.length && this.agent.steer) {
        const ok = await this.agent.steer(thread.data.agent, a.state, text).catch(e => { this.k.log("steer failed:", e); return false; });
        if (ok && l.active === a) {
          this.drop(job);
          a.steered.push(job);
          this.k.items.update(job.userId, { steered: true });
          this.k.items.update(job.replyId, { status: "done", text: "", steered: true });
          this.publish(job.threadId, job.replyId, { progress: "" });
          return;
        }
      }
      job.preparing = undefined;
      if (l.active?.stage === "working") this.halt(l.active); // a message still being heard is not stopped: this one simply goes next
    } finally { job.preparing = undefined; this.pump(job.threadId); }
  }

  /** Stops a running turn. While its voice message is heard, the message is cancelled (never sent). */
  private halt(a: Active) {
    if (a.ctl.signal.aborted) return;
    if (a.stage === "hearing") this.cancel(a.job);
    a.ctl.abort(new Error("stopped"));
  }
  /** A message that never reached the agent: the user message stays (voice, transcript) marked cancelled, the reply is skipped. */
  private cancel(job: Job) {
    this.k.items.update(job.userId, { status: "cancelled" });
    this.k.items.update(job.replyId, { status: "stopped", skipped: true });
    this.publish(job.threadId, job.userId, { progress: "" });
    this.publish(job.threadId, job.replyId, { progress: "" });
  }

  /** POST /threads/:id/stop {message?}: stops that message's turn (default: the running one), or takes it out of the line. */
  stopTurn(threadId: string, messageId?: string) {
    const t = this.k.items.get<Thread>(threadId);
    if (!t || t.type !== "thread") throw new HttpError(404, "no such thread");
    const l = this.line(threadId);
    let replyId: string | undefined = messageId || l.active?.job.replyId || l.jobs[0]?.replyId;
    if (messageId) {
      const m = this.k.items.get<Message>(messageId);
      if (!m || m.type !== "message" || m.data.thread !== threadId) throw new HttpError(404, "no such message here");
      if (m.data.role === "user") replyId = m.data.reply;
    }
    if (!replyId) throw new HttpError(409, "nothing is running here");
    if (l.active?.job.replyId === replyId) { this.halt(l.active); return { stopped: replyId }; }
    const job = l.jobs.find(j => j.replyId === replyId);
    if (!job) throw new HttpError(409, "that message is not waiting or running");
    job.preparing?.abort(new Error("stopped"));
    this.drop(job);
    this.cancel(job);
    this.pump(threadId);
    return { stopped: replyId };
  }

  private publish(thread: string, message: string, ev: Record<string, unknown>) {
    this.k.events.publish(TOPIC, { thread, message, ...ev });
  }

  private async attached(ids: string[]): Promise<AttachedFile[]> {
    const out: AttachedFile[] = [];
    for (const id of ids) {
      const it = this.k.items.get<FileData>(id), bytes = await this.k.files.read(id);
      if (it && bytes) out.push({ id, name: it.data.name, mime: it.data.mime, bytes });
    }
    return out;
  }

  private fail(job: Job, error: string) {
    this.k.items.update(job.replyId, { status: "error", error });
    this.publish(job.threadId, job.replyId, { progress: "" });
  }

  /** What the agent gets for a user message: the transcript (voice) and the typed text. */
  private promptOf(user: Item<Message>) {
    const text = user.data.text, transcript = user.data.transcript;
    return transcript !== undefined ? voicePrompt(this.k.user.name, transcript) + (text ? `\n\n${text}` : "") : text;
  }

  /**
   * Transcribes a voice message once. false = failed (marked) or stopped
   * (stopTurn marked it cancelled; the transcript still lands on it).
   */
  private async hear(job: Job, signal: AbortSignal): Promise<boolean> {
    const user = this.k.items.get<Message>(job.userId)!;
    if (!user.data.voice || user.data.transcript !== undefined) return true;
    if (signal.aborted) return false;
    this.publish(job.threadId, job.userId, { progress: "transcribing" });
    const work = (async () => {
      const [audio] = await this.attached([user.data.voice!]);
      const out = await this.stt.transcribe(audio.bytes, audio.mime);
      const cancelled = this.k.items.get<Message>(job.userId)?.data.status === "cancelled";
      this.k.items.update(job.userId, { transcript: out.text, ...(cancelled ? {} : { status: "done" }) });
      const t = this.k.items.get<Thread>(job.threadId)!;
      if (t.data.title === titleFrom(user.data.text) && out.text) this.setAutoTitle(job.threadId, titleFrom(out.text));
    })();
    const stopped = new Promise<"stopped">(res => signal.addEventListener("abort", () => res("stopped"), { once: true }));
    try {
      if (await Promise.race([work.then(() => "heard" as const), stopped]) === "heard") return true;
      work.catch(e => this.k.log("transcription of a cancelled message failed:", e));
      return false;
    } catch (e) {
      if (signal.aborted) return false;
      this.k.items.update(job.userId, { status: "error", error: `transcription failed: ${(e as Error).message}` });
      this.fail(job, "not sent: the voice message could not be transcribed");
      return false;
    }
  }

  /** One user message -> one agent reply. resumed = continue a run started before a restart. */
  private async turn(job: Job, a: Active) {
    const { threadId, userId, replyId, resumed } = job;
    const fail = (error: string) => this.fail(job, error);
    if (!(await this.hear(job, a.ctl.signal)) || a.ctl.signal.aborted) return;
    const user = this.k.items.get<Message>(userId)!;
    let text = this.promptOf(user);
    if (!text.trim() && !user.data.files.length) return fail("nothing to send: no speech recognised");
    if (user.data.context) text += `\n\n${user.data.context}`;

    const thread = this.k.items.get<Thread>(threadId)!;
    a.stage = "working";
    if (resumed) a.state = { ...(thread.data.state || {}) };
    this.k.items.update(replyId, { status: "working" });
    const turn: AgentTurn = { conversation: threadId, title: thread.data.title, state: thread.data.state || {},
      text: text + this.titleGuide(thread) + this.idsNote(thread, userId, replyId), files: await this.attached(user.data.files),
      signal: this.stopping.signal, cancel: a.ctl.signal };
    let reply = "", saved = Date.now();
    // stopped by the user: the partial reply stays, with a quiet note (never an error)
    const stopped = () => { this.k.items.update(replyId, { text: reply, status: "stopped" }); this.publish(threadId, replyId, { progress: "" }); };
    try {
      if (a.ctl.signal.aborted) return stopped();
      const stream = resumed && this.agent.resume ? this.agent.resume(thread.data.agent, turn) : this.agent.send(thread.data.agent, turn);
      for await (const ev of stream) {
        if (ev.type === "state") {
          a.state = { ...a.state, ...ev.state };
          const state = { ...(this.k.items.get<Thread>(threadId)!.data.state || {}), ...ev.state };
          this.k.items.update(threadId, { state });
        } else if (ev.type === "delta") {
          reply += ev.text;
          this.publish(threadId, replyId, { delta: ev.text });
          if (Date.now() - saved > SAVE_EVERY_MS) { saved = Date.now(); this.k.items.update(replyId, { text: reply }); }
        } else if (ev.type === "progress") {
          this.publish(threadId, replyId, { progress: ev.text });
        } else if (ev.type === "done") {
          const out = await this.media(ev.text || reply);
          for (const f of out.files) this.k.links.add(replyId, "file", f);
          // in a view's history thread, "@name args" lines are actions for the view to run
          const acts = thread.data.view ? extractActions(out.text) : null;
          this.k.items.update(replyId, { text: acts ? acts.text : out.text, files: out.files, status: "done",
            ...(acts?.actions.length ? { actions: acts.actions } : {}) });
          this.publish(threadId, replyId, { progress: "" });
          this.maybeRetitle(threadId);
          if (user.data.notice && !thread.data.view) this.k.items.update<Thread>(threadId, { unread: true }); // news nobody asked for: bold in the list
          // messages sent into this turn that it never took in: they get their own turns, next
          if (ev.unsent && a.steered.length) for (const j of [...a.steered].reverse()) {
            this.k.items.update(j.userId, { steered: false });
            this.k.items.update(j.replyId, { status: "queued", steered: false });
            this.enqueue({ threadId: j.threadId, userId: j.userId, replyId: j.replyId, resumed: false }, true);
          }
          return;
        } else if (ev.type === "error") {
          if (a.ctl.signal.aborted) return stopped();
          if (reply) this.k.items.update(replyId, { text: reply });
          return fail(ev.message);
        }
      }
      if (a.ctl.signal.aborted) return stopped();
      fail("the agent stopped without an answer");
    } catch (e) {
      if (a.ctl.signal.aborted) return stopped();
      if (this.stopping.signal.aborted) { this.k.items.update(replyId, { text: reply }); return; } // resumed after restart
      fail((e as Error).message || String(e));
    }
  }

  /** Turns interrupted by a restart: follow their agent run again. */
  resumeAll() {
    for (const reply of this.k.items.list<Message>({ type: "message", order: "created", limit: 10000 })) {
      if (reply.data.role !== "agent" || !["queued", "working"].includes(reply.data.status)) continue;
      const user = this.messages(reply.data.thread).find(m => m.data.reply === reply.id);
      if (!user) { this.k.items.update(reply.id, { status: "error", error: "lost its message" }); continue; }
      const resumed = reply.data.status === "working";
      this.enqueue({ threadId: reply.data.thread, userId: user.id, replyId: reply.id, resumed });
    }
  }

  /**
   * Shows declared action calls in the thread: a call by an agent goes on the
   * reply that agent is working on (the newest one if several run), and its
   * line is updated as the page reports. Calls outside a turn stay in the
   * kernel's log only (GET /k/actions).
   */
  watchCalls() {
    const off = this.k.events.subscribe(ITEM_TOPIC, ev => {
      const it = (ev as { item?: Item<{ agent: string; action: string; args: Record<string, unknown>; status: string; note?: string }> }).item;
      if (!it || it.type !== "action-call") return;
      try {
        let reply = this.callReply.get(it.id);
        if (!reply) {
          const working = this.k.items.list<Message>({ type: "message", order: "-created", limit: 200 })
            .filter(m => m.data.role === "agent" && m.data.status === "working"
              && this.k.items.get<Thread>(m.data.thread)?.data.agent === it.data.agent);
          if (!working.length) return;
          reply = working[0].id;
          this.callReply.set(it.id, reply);
        }
        const m = this.k.items.get<Message>(reply);
        if (!m) return;
        const calls = [...(m.data.calls || [])], line = { id: it.id, text: callText(it.data) };
        const i = calls.findIndex(c => c.id === it.id);
        if (i >= 0) calls[i] = line; else calls.push(line); // in the order they were called
        this.k.items.update(reply, { calls });
      } catch (e) { this.k.log("action call note failed:", e); }
    });
    this.stopping.signal.addEventListener("abort", off);
  }
  private callReply = new Map<string, string>(); // action-call id -> reply message id

  stop() { this.stopping.abort(new Error("kernel stopping")); }
}

let chat: Chat | null = null;

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const bad = (e: unknown, status = 400) => Response.json({ error: (e as Error).message || String(e) }, { status: (e as HttpError).status || status });

const plugin: ServerPlugin = {
  start(k) { chat = new Chat(k); chat.watchCalls(); chat.resumeAll(); },
  routes(): Record<string, (req: Request, p: Record<string, string>) => Response | Promise<Response>> {
    const c = () => chat!;
    return {
      "GET /agents": () => Response.json(c().agents()),
      "GET /recent": () => Response.json(c().recent()),
      "GET /threads": req => Response.json(c().threads(new URL(req.url).searchParams.get("hidden") === "1")),
      "POST /views/:view/thread": (_req, p) => { try { return Response.json(c().viewThread(p.view)); } catch (e) { return bad(e); } },
      "POST /threads": async req => {
        const b = await req.json().catch(() => ({})) as { title?: string };
        return Response.json(c().newThread(b.title), { status: 201 });
      },
      "PATCH /threads/:id": async (req, p) => {
        const b = await req.json().catch(() => ({})) as { title?: string; hidden?: boolean; read?: boolean };
        try { return Response.json(c().change(p.id, b)); } catch (e) { return bad(e); }
      },
      "POST /threads/:id/title": async (req, p) => {
        const b = await req.json().catch(() => ({})) as { title?: string };
        try { return Response.json(c().agentTitle(p.id, b.title as string)); } catch (e) { return bad(e); }
      },
      "GET /threads/:id/messages": (_req, p) => Response.json(c().messages(p.id)),
      "POST /threads/:id/messages": async (req, p) => {
        const b = await req.json() as { text?: string; files?: string[]; voice?: string; from?: string; context?: string; transcript?: string; mode?: string };
        try { return Response.json(c().post(p.id, String(b.text || ""), b.files || [], b.voice, b, b.mode || "queue"), { status: 201 }); }
        catch (e) { return bad(e); }
      },
      "POST /threads/:id/notices": async (req, p) => {
        const b = await req.json().catch(() => ({})) as { text?: string; notice?: string; key?: string };
        try { const out = c().notify(p.id, b); return Response.json(out, { status: (out as { repeated?: boolean }).repeated ? 200 : 201 }); }
        catch (e) { return bad(e); }
      },
      "POST /threads/:id/stop": async (req, p) => {
        const b = await req.json().catch(() => ({})) as { message?: string };
        try { return Response.json(c().stopTurn(p.id, b.message ? String(b.message) : undefined)); } catch (e) { return bad(e); }
      },
    };
  },
  stop() { chat?.stop(); },
};
export default plugin;
export type { Item };