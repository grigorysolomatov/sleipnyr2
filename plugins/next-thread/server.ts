// A new thread started from an open one.
//
//   POST /p/next-thread/from/:id  {mode: "clear" | "continue"}  -> the new thread (201)
//
// The new thread is an ordinary chat thread {title, agent, state: {}} plus
//   from       the thread it was started from
//   continues  true for Continue: the chat shows the old thread above it
// Link: new thread -from-> old thread.
//
// From a view's conversation (e.g. the thread list's, shown in its embedded
// chat) the new thread takes over that role: it gets the view, the old one
// loses it and so shows up in the thread list (kept, never deleted).
//
// Its state is empty, so the agent opens a fresh session on the first
// message, and the chat runs each thread's turns on their own queue: a busy
// or hung run in the old thread never delays the new one.
import type { Kernel, ServerPlugin } from "../../kernel/contract.ts";

export const MODES = ["clear", "continue"] as const;
export type Mode = (typeof MODES)[number];

interface Thread { title: string; agent: string; state: Record<string, unknown>; from?: string; continues?: boolean; view?: string; titleAuto?: boolean }

class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function nextThread(k: Kernel, fromId: string, mode: string) {
  if (!MODES.includes(mode as Mode)) throw new Refused(400, `mode must be ${MODES.join(" or ")}`);
  const from = k.items.get<Thread>(fromId);
  if (!from || from.type !== "thread") throw new Refused(404, "no such thread");
  const view = from.data.view;
  // the retired history goes to the archive (Archived in the list), not among the open threads
  if (view) k.items.update(from.id, { view: null, hidden: true, title: `${from.data.title} (until ${new Date().toLocaleString("sv-SE").slice(0, 16)})` });
  const t = k.items.create<Thread>("thread", { title: view ? from.data.title : "New thread", agent: from.data.agent, state: {},
    from: from.id, continues: mode === "continue", ...(view ? { view, titleAuto: false } : {}) });
  k.links.add(t.id, "from", from.id);
  return t;
}

const plugin: ServerPlugin = {
  routes: k => ({
    "POST /from/:id": async (req, p) => {
      const b = await req.json().catch(() => ({})) as { mode?: string };
      try { return Response.json(nextThread(k, p.id, String(b.mode || "")), { status: 201 }); }
      catch (e) { return Response.json({ error: (e as Error).message }, { status: (e as Refused).status || 400 }); }
    },
  }),
};
export default plugin;
