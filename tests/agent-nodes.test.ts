// agent-hermes nodes: an agent that moves between machines. Each turn goes to the
// node whose GET /health answers, and the reply names that node. Fake Hermes
// servers on loopback stand in for the machines.
import { afterAll, expect, test } from "bun:test";
import plugin from "../plugins/agent-hermes/server.ts";
import type { AgentEvent, AgentService } from "../kernel/contract.ts";

function fakeHermes(reply: string) {
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return Response.json({ status: "ok" });
    if (u.pathname === "/api/sessions") return Response.json({ ok: true });
    if (u.pathname === "/v1/runs") return Response.json({ run_id: "r1" });
    if (u.pathname === "/v1/runs/r1/events")
      return new Response(`data: ${JSON.stringify({ event: "run.completed", output: reply })}\n\n`);
    return new Response("no", { status: 404 });
  } });
}
const home = fakeHermes("from home"), cloud = fakeHermes("from cloud");
afterAll(() => { home.stop(true); cloud.stop(true); });
const down = "http://127.0.0.1:9"; // nothing listens there

function service(nodes: { name: string; url: string }[] | undefined, url = down): AgentService {
  let svc: AgentService | null = null;
  process.env.TEST_NODE_KEY = "k";
  plugin.start!({ config: { agents: [{ id: "e", name: "Agent", url, keyEnv: "TEST_NODE_KEY", nodes }] },
    user: { id: "me", name: "Me" }, log: () => {},
    services: { provide: (_: string, s: AgentService) => { svc = s; } } } as any);
  return svc!;
}
async function turn(s: AgentService) {
  const out: AgentEvent[] = [];
  for await (const ev of s.send("e", { conversation: "c", title: "t", state: {}, text: "hi", files: [] })) out.push(ev);
  return out;
}

test("a turn goes to the node that answers and the reply names it", async () => {
  const s = service([{ name: "home", url: down }, { name: "cloud", url: `http://127.0.0.1:${cloud.port}` }]);
  const evs = await turn(s);
  expect(evs.at(-1)).toEqual({ type: "done", text: "from cloud", node: "cloud" });
  expect(evs.find(e => e.type === "state" && "run_id" in e.state)).toMatchObject({ state: { node: "cloud" } });
  expect(s.agents()).toEqual([{ id: "e", name: "Agent", nodes: ["home", "cloud"] }]);
});

test("the first node wins when both answer", async () => {
  const s = service([{ name: "home", url: `http://127.0.0.1:${home.port}` }, { name: "cloud", url: `http://127.0.0.1:${cloud.port}` }]);
  expect((await turn(s)).at(-1)).toEqual({ type: "done", text: "from home", node: "home" });
});

test("without nodes: the plain url, and no node on the reply", async () => {
  const s = service(undefined, `http://127.0.0.1:${home.port}`);
  expect((await turn(s)).at(-1)).toEqual({ type: "done", text: "from home" });
  expect(s.agents()).toEqual([{ id: "e", name: "Agent" }]);
});
