// Projects (trial): the project list comes from the config
// (plugins.projects.list = [{id, title, doc}]); without one, a single example.
import type { ServerPlugin } from "../../kernel/contract.ts";

export interface Project { id: string; title: string; doc: string }
export const EXAMPLE: Project[] = [{ id: "example", title: "Example project", doc: "Set plugins.projects.list in the config" }];
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The configured projects, cleaned; the example when none are valid. */
export function projectsOf(list: unknown): Project[] {
  const out = (Array.isArray(list) ? list : []).flatMap(p => {
    const x = p as Partial<Project>;
    return x && ID.test(String(x.id)) && x.title ? [{ id: String(x.id), title: String(x.title), doc: String(x.doc || "") }] : [];
  });
  return out.length ? out : EXAMPLE;
}

const plugin: ServerPlugin = {
  routes: k => ({ "GET /list": () => Response.json(projectsOf(k.config.list)) }),
};
export default plugin;
