// Saved items, links and file bytes: one SQLite file plus a content-addressed
// folder for file bytes. Implements the Items, Links and Files parts of the
// contract. Nothing is ever deleted in v1.
import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FileData, Files, Item, ItemQuery, Items, Link, Links } from "./contract.ts";

const SCHEMA = `
create table if not exists items (
  id text primary key, type text not null, data text not null,
  created integer not null, updated integer not null, by text not null);
create index if not exists items_type on items (type, created);
create table if not exists links (
  src text not null, rel text not null, dst text not null, created integer not null,
  primary key (src, rel, dst));
create index if not exists links_dst on links (dst, rel);
`;

type Row = { id: string; type: string; data: string; created: number; updated: number; by: string };

const toItem = <D>(r: Row): Item<D> => ({ ...r, data: JSON.parse(r.data) as D });

/** Short random id: type initial + 10 hex chars, e.g. t_3f9a0c12be. */
function newId(type: string): string {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `${(type[0] || "x").toLowerCase()}_${hex}`;
}

export class Store {
  readonly db: Database;
  readonly filesDir: string;
  /** called after every create/update (the kernel publishes it as an event) */
  onChange: (item: Item) => void = () => {};
  /** called after an item was deleted */
  onRemove: (item: Item) => void = () => {};

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filesDir = join(dataDir, "files");
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new Database(join(dataDir, "kernel.sqlite"), { create: true });
    this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /** The Items API, with every change attributed to `by`. */
  items(by: string): Items {
    const db = this.db;
    const self = this;
    return {
      get<D>(id: string) {
        const r = db.query<Row, [string]>("select * from items where id = ?").get(id);
        return r ? toItem<D>(r) : null;
      },
      list<D>(q: ItemQuery = {}) {
        const where: string[] = [], args: (string | number)[] = [];
        if (q.type) { where.push("i.type = ?"); args.push(q.type); }
        let from = "items i";
        if (q.linkedTo) {
          from += " join links l on l.src = i.id and l.rel = ? and l.dst = ?";
          args.unshift(q.linkedTo.rel, q.linkedTo.to);
        }
        const order = { created: "i.created", "-created": "i.created desc",
          updated: "i.updated", "-updated": "i.updated desc" }[q.order || "created"];
        const sql = `select i.* from ${from}${where.length ? " where " + where.join(" and ") : ""}`
          + ` order by ${order} limit ${Math.max(1, Math.min(q.limit ?? 1000, 10000))}`;
        return db.query<Row, (string | number)[]>(sql).all(...args).map(r => toItem<D>(r));
      },
      create<D extends object>(type: string, data: D) {
        const now = Date.now();
        const item: Item<D> = { id: newId(type), type, data, created: now, updated: now, by };
        db.query("insert into items values (?, ?, ?, ?, ?, ?)")
          .run(item.id, type, JSON.stringify(data), now, now, by);
        self.onChange(item as Item);
        return item;
      },
      remove(id: string) {
        const cur = this.get<Record<string, unknown>>(id);
        if (!cur) return false;
        db.transaction(() => {
          db.query("delete from items where id = ?").run(id);
          db.query("delete from links where src = ? or dst = ?").run(id, id);
        })();
        // the bytes of a file go when no other file item holds the same content
        const sha = cur.type === "file" ? String(cur.data.sha256 || "") : "";
        if (/^[0-9a-f]{64}$/.test(sha) && !db.query("select 1 from items where type = 'file' and json_extract(data, '$.sha256') = ? limit 1").get(sha))
          try { unlinkSync(join(self.filesDir, sha)); } catch { /* already gone */ }
        self.onRemove(cur as Item);
        return true;
      },
      usedBy(id: string) {
        const rows = db.query<{ id: string }, [string, string, string]>(
          "select src as id from links where dst = ? union select id from items where id != ? and instr(data, ?) > 0").all(id, id, `"${id}"`);
        return [...new Set(rows.map(r => r.id))].filter(x => x !== id);
      },
      update<D>(id: string, patch: Record<string, unknown>) {
        const cur = this.get<Record<string, unknown>>(id);
        if (!cur) throw new Error(`no item ${id}`);
        const data = { ...cur.data };
        for (const [k, v] of Object.entries(patch)) v === null ? delete data[k] : (data[k] = v);
        const now = Math.max(Date.now(), cur.updated + 1);
        db.query("update items set data = ?, updated = ?, by = ? where id = ?")
          .run(JSON.stringify(data), now, by, id);
        const item = { ...cur, data, updated: now, by } as Item<D>;
        self.onChange(item as Item);
        return item;
      },
    };
  }

  links(): Links {
    const db = this.db;
    return {
      add(src, rel, dst) {
        const link: Link = { src, rel, dst, created: Date.now() };
        db.query("insert or ignore into links values (?, ?, ?, ?)").run(src, rel, dst, link.created);
        return link;
      },
      list(q) {
        const where: string[] = [], args: string[] = [];
        for (const k of ["src", "rel", "dst"] as const) if (q[k]) { where.push(`${k} = ?`); args.push(q[k]!); }
        return db.query<Link, string[]>(`select * from links${where.length ? " where " + where.join(" and ") : ""}`
          + " order by created").all(...args);
      },
    };
  }

  files(by: string): Files {
    const items = this.items(by), dir = this.filesDir;
    return {
      put(name, mime, bytes) {
        const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        Bun.write(join(dir, sha256), bytes);
        return items.create<FileData>("file", { name, mime, size: bytes.length, sha256 });
      },
      async read(id) {
        const it = items.get<FileData>(id);
        if (!it || it.type !== "file") return null;
        const f = Bun.file(join(dir, it.data.sha256));
        return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
      },
    };
  }
}
