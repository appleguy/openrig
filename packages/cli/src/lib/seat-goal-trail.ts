import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { addProgressRow } from "./scope/progress-edit.js";
import { readFrontmatter } from "./scope/scope-fs.js";
import type { WorkInstallResult } from "./work-install.js";
import type { GoalObjectiveMetadata } from "./seat-goal-objective.js";

export interface SeatGoalOutcome {
  operation: "set" | "clear";
  seat: string;
  threadId: string;
  changed: boolean;
  status: string | null;
  objectiveSource?: GoalObjectiveMetadata;
}

export type SeatGoalTrailTarget = {
  ok: true;
  path: string;
  scope: "mission" | "slice";
  mission: string;
  slice?: string;
} | {
  ok: false;
  code: string;
  message: string;
};

/** Resolve an existing selected scope rail. This never scaffolds a mission, slice, or progress file. */
export function resolveSeatGoalTrailTarget(work: WorkInstallResult): SeatGoalTrailTarget {
  if ("error" in work) return { ok: false, code: work.error.code, message: work.error.message };
  const position = work.position;
  if (!position.mission || !position.missionRoot || !isDirectory(position.missionRoot)) {
    return { ok: false, code: "goal_scope_missing", message: "A resolvable mission is required to record a seat-goal outcome." };
  }

  const scope = position.slice ? "slice" : "mission";
  const scopeRoot = scope === "slice" ? position.sliceRoot : position.missionRoot;
  if (!scopeRoot || !isDirectory(scopeRoot)) {
    return { ok: false, code: scope === "slice" ? "goal_slice_unresolved" : "goal_mission_unresolved",
      message: `The selected ${scope} root is unavailable; no goal mutation was sent.` };
  }

  const progressAddress = scope === "mission" ? "mission:PROGRESS.md" : `mission:slices/${position.slice}/PROGRESS.md`;
  const progressPieces = work.pieces.filter((piece) => piece.altitude === scope && piece.address === progressAddress);
  if (progressPieces.length !== 1) {
    return { ok: false, code: "goal_progress_unresolved", message: `Work-install did not resolve one ${scope} progress rail.` };
  }
  const progressPiece = progressPieces[0]!;
  if (isFile(progressPiece.path)) {
    return { ok: true, path: progressPiece.path, scope, mission: position.mission,
      ...(scope === "slice" ? { slice: position.slice! } : {}) };
  }

  // The existing scope convention permits an explicitly readme-only rail. Use its authored node file,
  // but do not create a new progress surface as a side effect of goal control.
  const specPieces = work.pieces.filter((piece) => piece.altitude === scope && piece.address !== progressAddress);
  if (specPieces.length !== 1 || !isFile(specPieces[0]!.path)
    || readFrontmatter(specPieces[0]!.path).progress_rail !== "readme-only") {
    return { ok: false, code: "goal_progress_unavailable",
      message: `The selected ${scope} has no existing PROGRESS.md or readme-only rail; no goal mutation was sent.` };
  }
  return { ok: true, path: specPieces[0]!.path, scope, mission: position.mission,
    ...(scope === "slice" ? { slice: position.slice! } : {}) };
}

/** Append the verified native result to the selected scope's existing Outcomes rail. Replays are idempotent. */
export function recordSeatGoalOutcome(work: WorkInstallResult, outcome: SeatGoalOutcome): {
  target: SeatGoalTrailTarget & { ok: true };
  changed: boolean;
} {
  const target = resolveSeatGoalTrailTarget(work);
  if (!target.ok) throw Object.assign(new Error(target.message), { code: target.code });

  const source = outcome.objectiveSource ? formatSource(outcome.objectiveSource) : "explicit objective";
  const result = outcome.operation === "clear" ? "cleared" : `set ${outcome.status ?? "unknown status"}`;
  const text = `Codex seat goal ${outcome.operation}: ${result}; seat=${outcome.seat}; thread=${outcome.threadId}; changed=${outcome.changed}; source=${source}`;
  const before = readFileSync(target.path, "utf8");
  const edited = addProgressRow(before, { section: "Outcomes", text, status: "done" });
  if (edited.changed) writeFileSync(target.path, edited.content, "utf8");
  return { target, changed: edited.changed };
}

function formatSource(source: GoalObjectiveMetadata): string {
  return source.fallback
    ? `${source.altitude}:${source.specAddress} (fallback from ${source.fallback.from.specAddress}: ${source.fallback.reason})`
    : `${source.altitude}:${source.specAddress}`;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}
