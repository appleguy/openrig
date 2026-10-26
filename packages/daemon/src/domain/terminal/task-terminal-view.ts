import type Database from "better-sqlite3";
import { hasOtherSeatHistory } from "../session-registry.js";
import type { ViewMemberInput } from "./view-composer.js";

export interface TaskObligation { qitemId: string; state: string }
export interface TaskTerminalMember {
  key: { hostId: string | null; nodeId: string | null };
  seat: string;
  obligations: TaskObligation[];
  availability: "available" | "missing" | "stopped" | "hosted" | "unresolved";
  reason?: string;
  /** Membership does not provision or authorize terminal input. */
  viewerStatus: "not-provisioned";
}
export interface TaskMembership {
  qitemId: string;
  name: string;
  complete: boolean;
  issues: string[];
  members: TaskTerminalMember[];
}
export interface TaskSeat {
  hostId: string | null;
  nodeId: string;
  seat: string;
  runtime?: string | null;
  tmuxSession: string | null;
  attachmentType: string | null;
  stopped: boolean;
}
export interface TaskTerminalView { task: TaskMembership; members: ViewMemberInput[] }
interface EpisodeRow {
  qitem_id: string; summary: string | null; destination_session: string; state: string;
  handed_off_from: string | null; chain_of_record: string | null;
}
const ACTIVE = new Set(["pending", "in-progress", "blocked"]);
const MAX_EPISODE_ROWS = 256;

/** Read only this local episode, never an unbounded latest-items projection.
 * UNION makes a corrupt cyclic link terminate; the bound is disclosed, not
 * mistaken for a complete team. No ancestor/sibling expansion or foreign I/O.
 */
export function readTaskTerminalView(
  db: Database.Database,
  qitemId: string,
  resolveSeat: (address: string) => TaskSeat | null,
): TaskTerminalView | null {
  const rows = db.prepare(`WITH RECURSIVE episode(id) AS (
    SELECT qitem_id FROM queue_items WHERE qitem_id = ?
    UNION
    SELECT q.qitem_id FROM queue_items q JOIN episode e ON
      q.handed_off_from = e.id OR EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(q.chain_of_record) THEN
          CASE WHEN json_type(q.chain_of_record)='array' THEN q.chain_of_record ELSE '[]' END ELSE '[]' END) c WHERE c.value = e.id
      )
    LIMIT ?
  ) SELECT q.qitem_id, q.summary, q.destination_session, q.state, q.handed_off_from, q.chain_of_record
    FROM queue_items q JOIN episode e ON e.id=q.qitem_id ORDER BY q.qitem_id`)
    .all(qitemId, MAX_EPISODE_ROWS + 1) as EpisodeRow[];
  if (!rows.some(row => row.qitem_id === qitemId)) return null;
  const issues: string[] = [];
  if (rows.length > MAX_EPISODE_ROWS) issues.push(`Episode exceeds ${MAX_EPISODE_ROWS} local rows; membership is incomplete.`);
  // Keep the requested root even when the recursive bound was reached.
  const selected = [rows.find(row => row.qitem_id === qitemId)!, ...rows.filter(row => row.qitem_id !== qitemId)]
    .slice(0, MAX_EPISODE_ROWS);
  const ids = new Set(selected.map(row => row.qitem_id));
  const parents = new Map<string, string[]>();
  for (const row of selected) {
    let chain: unknown = [];
    try { chain = JSON.parse(row.chain_of_record ?? "[]"); } catch { chain = null; }
    if (!Array.isArray(chain)) {
      issues.push(`Unreadable lineage on ${row.qitem_id}.`);
      chain = [];
    }
    const refs = [...new Set([row.handed_off_from, ...(chain as unknown[])
      .filter((id): id is string => typeof id === "string" && id.startsWith("qitem-"))]
      .filter((id): id is string => id !== null))];
    // The root's own ancestry is deliberately outside this view.
    if (row.qitem_id !== qitemId) {
      for (const ref of refs) {
        if (!ids.has(ref) && !db.prepare("SELECT 1 FROM queue_items WHERE qitem_id=?").get(ref)) {
          issues.push(`Lineage ${ref} referenced by ${row.qitem_id} is not available locally.`);
        }
      }
    }
    parents.set(row.qitem_id, refs.filter(id => ids.has(id)));
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { issues.push(`Cyclic lineage at ${id}.`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of parents.get(id) ?? []) visit(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const row of selected) visit(row.qitem_id);

  const owners = new Map<string, TaskTerminalMember>();
  const inputs = new Map<string, ViewMemberInput>();
  const resolved = new Map<string, TaskSeat | null>();
  for (const row of selected) {
    if (!ACTIVE.has(row.state)) continue;
    const address = row.destination_session;
    if (!resolved.has(address)) resolved.set(address, resolveSeat(address));
    const seat = resolved.get(address)!;
    // An unresolved address is retained separately: two unknowns are not one node.
    const id = JSON.stringify(seat ? [seat.hostId, seat.nodeId] : [null, null, address]);
    const existing = owners.get(id);
    if (existing) { existing.obligations.push({ qitemId: row.qitem_id, state: row.state }); continue; }
    const availability = !seat ? "unresolved" : seat.stopped ? "stopped"
      : seat.attachmentType === "external_cli" ? "hosted" : !seat.tmuxSession ? "missing" : "available";
    const reason = availability === "unresolved" ? "Owner has no unambiguous local seat binding; remote owners are not crawled."
      : availability === "stopped" ? "Seat is stopped."
      : availability === "hosted" ? "Seat has no tmux terminal attachment."
      : availability === "missing" ? "No tmux session is recorded for this seat." : undefined;
    owners.set(id, { key: { hostId: seat?.hostId ?? null, nodeId: seat?.nodeId ?? null }, seat: seat?.seat ?? address,
      obligations: [{ qitemId: row.qitem_id, state: row.state }], availability, ...(reason ? { reason } : {}), viewerStatus: "not-provisioned" });
    if (availability === "available" && seat) inputs.set(id, {
      seat: seat.seat, label: seat.seat, ...(seat.runtime ? { runtime: seat.runtime } : {}),
      tmuxSession: seat.tmuxSession, host: null, alive: true,
      // A task can span rigs. Membership is not authority to type; retain the
      // existing derived-scope read-only policy, independent of owner ensure.
      readOnly: true,
    });
  }
  const members = [...owners.values()].sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)) || a.seat.localeCompare(b.seat));
  return { task: { qitemId, name: selected[0]!.summary?.trim() || qitemId, complete: issues.length === 0, issues: [...new Set(issues)], members }, members: [...inputs.values()] };
}

/** Preserve local stopped/unlaunched owners as well as current registry aliases.
 * The registry's node id wins; an unresolved spelling must match exactly one
 * unarchived node/latest-session record. No host suffix is guessed or stripped.
 */
export function resolveLocalTaskSeat(
  db: Database.Database, address: string, hostId: string | null, currentNodeId?: string,
): TaskSeat | null {
  const rows = db.prepare(`SELECT n.id AS nodeId, n.runtime, s.session_name AS seat,
      s.status, b.tmux_session AS tmuxSession, b.attachment_type AS attachmentType
    FROM nodes n JOIN rigs r ON r.id=n.rig_id
    LEFT JOIN sessions s ON s.id=(SELECT id FROM sessions WHERE node_id=n.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN bindings b ON b.node_id=n.id
    WHERE r.archived_at IS NULL AND (n.id=? OR
      (? IS NULL AND (s.session_name=? OR replace(n.logical_id, '.', '-') || '@' || r.name=?)))`)
    .all(currentNodeId ?? null, currentNodeId ?? null, address, address) as Array<{
      nodeId: string; runtime: string | null; seat: string | null;
      status: string | null; tmuxSession: string | null; attachmentType: string | null;
    }>;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (!currentNodeId && row.seat !== address && hasOtherSeatHistory(db, address, row.nodeId)) return null;
  return { ...row, hostId, seat: row.seat ?? address,
    stopped: row.status === "exited" || row.status === "detached" || row.status === "superseded" };
}
