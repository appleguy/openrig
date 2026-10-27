import { readFileSync, statSync } from "node:fs";
import { splitFrontmatter } from "./scope/scope-fs.js";
import type { WorkInstallPiece, WorkInstallResult, WorkInstallSource, WorkInstallSelectedBy } from "./work-install.js";

export type GoalObjectiveAltitude = "slice" | "mission";

export interface GoalObjectiveSource {
  altitude: GoalObjectiveAltitude;
  specPath: string;
  specAddress: string;
  selectionSource: WorkInstallSource;
}

export type GoalObjectiveFallbackReason = "spec_missing" | "intent_missing" | "intent_invalid";

export interface GoalObjectiveFallback {
  from: GoalObjectiveSource;
  reason: GoalObjectiveFallbackReason;
}

/** The context belongs to the invoking seat's work-install selection, not the target goal seat. */
export interface GoalWorkPositionSource {
  selectedFor: "caller";
  selectedBy: WorkInstallSelectedBy;
  projectId: string | null;
  mission: string | null;
  slice: string | null;
}

export interface GoalObjectiveMetadata extends GoalObjectiveSource {
  /** Present when the caller explicitly opted into deriving an objective from its selected work position. */
  workPosition?: GoalWorkPositionSource;
  fallback?: GoalObjectiveFallback;
}

export type SeatGoalObjectiveResolution =
  | { ok: true; objective: string; source: GoalObjectiveSource; fallback?: GoalObjectiveFallback }
  | { ok: false; error: { code: string; message: string; candidates?: string[] } };

type IntentRead =
  | { kind: "found"; objective: string }
  | { kind: "absent"; reason: GoalObjectiveFallbackReason }
  | { kind: "unreadable"; error: string };

/**
 * Resolve an objective only from the selected mission/slice pieces produced by
 * resolveWorkPosition. Slice SPEC intent wins; an authored mission SPEC intent
 * is the explicit fallback when a selected slice has no usable intent.
 */
export function resolveSeatGoalObjective(work: WorkInstallResult): SeatGoalObjectiveResolution {
  if ("error" in work) return { ok: false, error: work.error };

  const selected = work.position;
  if (!selected.mission) {
    return failure("goal_scope_missing", "No mission is selected; a project-level intent is not a seat-goal objective.");
  }
  if (!selected.missionRoot || !isDirectory(selected.missionRoot)) {
    return failure("goal_mission_unresolved", `Mission '${selected.mission}' was selected but work-install did not resolve its root.`);
  }
  if (selected.slice && !selected.sliceRoot) {
    return failure("goal_slice_unresolved", `Slice '${selected.slice}' was selected but work-install did not resolve its root.`);
  }
  if (selected.sliceRoot && !isDirectory(selected.sliceRoot)) {
    return failure("goal_slice_unresolved", `Selected slice '${selected.slice}' no longer resolves to a directory.`);
  }
  if (!selected.slice && selected.sliceRoot) {
    return failure("goal_scope_invalid", "Work-install returned a slice root without a selected slice.");
  }

  let fallback: GoalObjectiveFallback | undefined;
  if (selected.slice && selected.sliceRoot) {
    const slicePiece = findSpecPiece(work.pieces, "slice", selected.slice);
    if ("error" in slicePiece) return { ok: false, error: slicePiece.error };
    const sliceSource = sourceOf(slicePiece);
    const sliceIntent = readIntent(slicePiece);
    if (sliceIntent.kind === "found") {
      return { ok: true, objective: sliceIntent.objective, source: sliceSource };
    }
    if (sliceIntent.kind === "unreadable") {
      return failure("goal_objective_spec_unreadable", `Selected slice SPEC ${slicePiece.path} could not be read: ${sliceIntent.error}`);
    }
    fallback = { from: sliceSource, reason: sliceIntent.reason };
  }

  const missionPiece = findSpecPiece(work.pieces, "mission");
  if ("error" in missionPiece) return { ok: false, error: missionPiece.error };
  const missionIntent = readIntent(missionPiece);
  if (missionIntent.kind === "found") {
    return {
      ok: true,
      objective: missionIntent.objective,
      source: sourceOf(missionPiece),
      ...(fallback ? { fallback } : {}),
    };
  }
  if (missionIntent.kind === "unreadable") {
    return failure("goal_objective_spec_unreadable", `Selected mission SPEC ${missionPiece.path} could not be read: ${missionIntent.error}`);
  }
  const fallbackText = fallback
    ? ` Selected slice SPEC ${fallback.from.specPath} had ${fallback.reason.replaceAll("_", " ")}.`
    : "";
  return failure("goal_objective_missing", `Selected mission SPEC ${missionPiece.path} has no nonempty frontmatter intent.${fallbackText}`);
}

function findSpecPiece(
  pieces: WorkInstallPiece[],
  altitude: GoalObjectiveAltitude,
  slice?: string,
): WorkInstallPiece | { error: { code: string; message: string; candidates?: string[] } } {
  const prefix = altitude === "mission" ? "mission:" : `mission:slices/${slice}/`;
  const progressAddress = altitude === "mission" ? "mission:PROGRESS.md" : `${prefix}PROGRESS.md`;
  const candidates = pieces.filter((piece) =>
    piece.altitude === altitude && piece.address.startsWith(prefix) && piece.address !== progressAddress,
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    return {
      error: {
        code: "goal_objective_spec_ambiguous",
        message: `Work-install returned multiple ${altitude} SPEC addresses for the selected scope.`,
        candidates: candidates.map((piece) => piece.address),
      },
    };
  }
  return {
    error: {
      code: "goal_objective_spec_unresolved",
      message: `Work-install returned no ${altitude} SPEC address for the selected scope.`,
    },
  };
}

function sourceOf(piece: WorkInstallPiece): GoalObjectiveSource {
  return {
    altitude: piece.altitude as GoalObjectiveAltitude,
    specPath: piece.path,
    specAddress: piece.address,
    selectionSource: piece.source,
  };
}

function readIntent(piece: WorkInstallPiece): IntentRead {
  let content: string;
  try {
    content = readFileSync(piece.path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent", reason: "spec_missing" };
    return { kind: "unreadable", error: (error as Error).message };
  }
  const intent = splitFrontmatter(content).frontmatter["intent"];
  if (typeof intent === "string") {
    const objective = intent.trim();
    return objective ? { kind: "found", objective } : { kind: "absent", reason: "intent_missing" };
  }
  return intent === undefined
    ? { kind: "absent", reason: "intent_missing" }
    : { kind: "absent", reason: "intent_invalid" };
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function failure(code: string, message: string): SeatGoalObjectiveResolution {
  return { ok: false, error: { code, message } };
}
