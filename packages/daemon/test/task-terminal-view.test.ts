import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { readTaskTerminalView, resolveLocalTaskSeat, type TaskSeat } from "../src/domain/terminal/task-terminal-view.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { terminalRoutes } from "../src/routes/terminal.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db);
  db.exec(`CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY,destination_session TEXT,state TEXT,handed_off_from TEXT,chain_of_record TEXT);
    CREATE TABLE rigs(id TEXT PRIMARY KEY,name TEXT,archived_at TEXT);
    CREATE TABLE nodes(id TEXT PRIMARY KEY,rig_id TEXT,logical_id TEXT,runtime TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,node_id TEXT,session_name TEXT,status TEXT);
    CREATE TABLE bindings(node_id TEXT,tmux_session TEXT,attachment_type TEXT);`);
  const add = (id: string, owner = "a@team", state = "in-progress", parent: string | null = null, chain: string[] = []) =>
    db.prepare("INSERT INTO queue_items VALUES (?,?,?,?,?)").run(id, owner, state, parent, JSON.stringify(chain));
  const seat = (address: string): TaskSeat | null => address.includes("@remote") ? null
    : { hostId: "box", nodeId: address.split("@")[0]!, seat: address, runtime: "stub", stopped: false, attachmentType: "tmux", tmuxSession: address };
  const read = (root = "qitem-root") => readTaskTerminalView(db, root, seat);
  return { db, add, seat, read };
}

describe("task terminal membership", () => {
  it("tracks three to four to three current owners without historical senders", () => {
    const { db, add, read } = fixture();
    add("qitem-root"); add("qitem-b", "b@team", "pending", "qitem-root"); add("qitem-c", "c@team", "blocked", null, ["qitem-root"]);
    add("qitem-old", "old@team", "done", "qitem-root");
    expect(read()!.task.members.map(m => m.seat)).toEqual(["a@team", "b@team", "c@team"]);
    add("qitem-d", "d@team", "in-progress", "qitem-b");
    expect(read()!.task.members).toHaveLength(4);
    db.prepare("UPDATE queue_items SET state='handed-off' WHERE qitem_id='qitem-b'").run();
    expect(read()!.task.members.map(m => m.seat)).toEqual(["a@team", "c@team", "d@team"]);
    expect(read()!.task.members.find(m => m.seat === "c@team")!.obligations).toEqual([{ qitemId: "qitem-c", state: "blocked" }]);
  });
  it("does not widen a child episode into its parent, siblings or unrelated rows", () => {
    const { add, read } = fixture();
    add("qitem-parent", "parent@team"); add("qitem-root", "a@team", "in-progress", "qitem-parent", ["qitem-parent"]);
    add("qitem-sibling", "sibling@team", "pending", "qitem-parent"); add("qitem-unrelated", "other@team");
    expect(read()!.task.members.map(m => m.seat)).toEqual(["a@team"]);
  });
  it("deduplicates actual host/node identities and explains each active obligation", () => {
    const { db, add, seat } = fixture(); add("qitem-root"); add("qitem-alias", "alias@team", "blocked", "qitem-root");
    const result = readTaskTerminalView(db, "qitem-root", address => address === "alias@team" ? seat("a@team") : seat(address))!;
    expect(result.task.members).toHaveLength(1); expect(result.members).toHaveLength(1);
    expect(result.task.members[0]!.obligations).toHaveLength(2);
  });
  it("retains same-named nodes on different hosts and distinct unresolved destinations", () => {
    const { db, add, seat } = fixture(); add("qitem-root"); add("qitem-foreign", "a@remote", "pending", "qitem-root");
    const result = readTaskTerminalView(db, "qitem-root", address => ({ ...seat("a@team")!, hostId: address === "a@remote" ? "other" : "box" }))!;
    expect(result.task.members).toHaveLength(2);
    add("qitem-unknown", "b@remote", "blocked", "qitem-root");
    expect(readTaskTerminalView(db, "qitem-root", seat)!.task.members.filter(m => m.availability === "unresolved")).toHaveLength(2);
  });
  it("does not hide stopped, unbound or external owners, and never provisions a viewer", () => {
    const { db, add, seat } = fixture(); add("qitem-root"); add("qitem-stopped", "stopped@team", "blocked", "qitem-root");
    add("qitem-hosted", "hosted@team", "pending", "qitem-root"); add("qitem-missing", "missing@team", "pending", "qitem-root");
    const result = readTaskTerminalView(db, "qitem-root", address => ({ ...seat(address)!, stopped: address.startsWith("stopped"),
      tmuxSession: address.startsWith("missing") ? null : address, attachmentType: address.startsWith("hosted") ? "external_cli" : "tmux" }))!;
    expect(result.task.members.map(m => m.availability).sort()).toEqual(["available", "hosted", "missing", "stopped"]);
    expect(result.members).toHaveLength(1);
    expect(result.task.members.every(m => m.viewerStatus === "not-provisioned")).toBe(true);
  });
  it("returns a truthful empty completed episode and distinguishes an unknown root", () => {
    const { add, read } = fixture(); add("qitem-root", "old@team", "done");
    expect(read()!.task).toMatchObject({ complete: true, members: [] }); expect(read("qitem-absent")).toBeNull();
  });
  it("does not use a latest-100 window and discloses the explicit episode bound", () => {
    const { add, read } = fixture(); add("qitem-root");
    for (let i = 0; i < 260; i++) add(`qitem-child-${i}`, `member${i}@team`, "pending", "qitem-root");
    const result = read()!; expect(result.task.members).toHaveLength(256); expect(result.task.complete).toBe(false);
    expect(result.task.issues.join(" ")).toContain("incomplete");
  });
  it("discloses cycles and missing local lineage without walking foreign queues", () => {
    const { db, add, read } = fixture(); add("qitem-root", "a@team", "in-progress", "qitem-cycle");
    add("qitem-cycle", "b@team", "pending", "qitem-root", ["qitem-root", "qitem-unavailable"]);
    expect(read()!.task.complete).toBe(false); expect(read()!.task.issues.join(" ")).toContain("Cyclic");
    expect(read()!.task.issues.join(" ")).toContain("not available locally");
    db.prepare("UPDATE queue_items SET chain_of_record='broken' WHERE qitem_id='qitem-cycle'").run();
    expect(read()!.task.issues.join(" ")).toContain("Unreadable");
  });
  it("resolves stopped and never-launched nodes through local identity, without guessed sockets", () => {
    const { db } = fixture(); db.exec(`INSERT INTO rigs VALUES('rig','team',NULL);
      INSERT INTO nodes VALUES('stopped','rig','dev.stopped','stub'),('new','rig','dev.new','stub');
      INSERT INTO sessions VALUES('s','stopped','dev-stopped@team','exited');`);
    expect(resolveLocalTaskSeat(db, "dev-stopped@team", "box")).toMatchObject({ nodeId: "stopped", stopped: true, tmuxSession: null });
    expect(resolveLocalTaskSeat(db, "dev-new@team", "box")).toMatchObject({ nodeId: "new", tmuxSession: null });
    expect(resolveLocalTaskSeat(db, "dev-new@team@foreign", "box")).toBeNull();
    db.exec("INSERT INTO nodes VALUES('duplicate','rig','dev.new','stub')");
    expect(resolveLocalTaskSeat(db, "dev-new@team", "box")).toBeNull();
    db.exec(`DELETE FROM nodes WHERE id='duplicate';
      INSERT INTO rigs VALUES('archived','different-team','earlier');
      INSERT INTO nodes VALUES('old-owner','archived','someone.else','stub');
      INSERT INTO sessions VALUES('old','old-owner','dev-new@team','exited');`);
    // The stopped-seat fallback must not bypass the registry's reserved-name history.
    expect(resolveLocalTaskSeat(db, "dev-new@team", "box")).toBeNull();
  });
  it("composes the same truthful task in HTTP preview/open, preserves preconditions and scopes input read-only", async () => {
    const { add, read } = fixture(); add("qitem-root"); add("qitem-unresolved", "b@remote", "blocked", "qitem-root");
    const opened: string[][] = [];
    const svc = new TerminalService({ resolveTaskView: () => read(), viewsStore: { list: () => [], get: () => null },
      listRigSeats: () => null, listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [], resolveHost: () => null,
      hasSession: () => true, resolveProvider: () => ({ name: "herdr", status: async () => ({ provider: "herdr", available: true, capabilities: {} }),
        liveness: async () => ({ alive: true }), openView: async view => {
          expect(view.opened.every(member => member.readOnly)).toBe(true); opened.push(view.opened.map(m => m.seat));
          return { provider: "herdr", ok: true, opened: view.opened.map(m => m.seat), absent: view.absent, degraded: [], pages: view.pages.length };
        } }) } satisfies TerminalServiceDeps);
    const app = new Hono(); app.use("*", async (c, next) => { c.set("terminalService" as never, svc as never); await next(); });
    app.route("/api/terminal", terminalRoutes());
    const response = await app.request("/api/terminal/preview?view=qitem:qitem-root&provider=herdr");
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.task.members).toHaveLength(2); expect(preview.composed.absent[0].seat).toBe("b@remote"); expect(opened).toHaveLength(0);
    const send = (expectedPlan: string) => app.request("/api/terminal/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: "qitem:qitem-root", provider: "herdr", expectedPlan }) });
    expect((await send("stale")).status).toBe(409); expect(opened).toHaveLength(0);
    const result = await (await send(preview.planId)).json(); expect(result.task).toEqual(preview.task); expect(opened).toEqual([["a@team"]]);
    add("qitem-join", "c@team", "pending", "qitem-root");
    expect((await send(preview.planId)).status).toBe(409); expect(opened).toHaveLength(1);
  });
});
