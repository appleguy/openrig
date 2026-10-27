import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSeatGoalOutcome, resolveSeatGoalTrailTarget } from "../src/lib/seat-goal-trail.js";
import type { WorkInstallPlan } from "../src/lib/work-install.js";

describe("seat goal progress trail", () => {
  let root: string;
  let work: WorkInstallPlan;

  function makeWork(withProgress = true): WorkInstallPlan {
    root = mkdtempSync(join(tmpdir(), "openrig-seat-goal-trail-"));
    const missionRoot = join(root, "missions", "audit");
    const sliceRoot = join(missionRoot, "slices", "01-goal");
    mkdirSync(sliceRoot, { recursive: true });
    const missionSpec = join(missionRoot, "SPEC.md");
    const missionProgress = join(missionRoot, "PROGRESS.md");
    const sliceSpec = join(sliceRoot, "SPEC.md");
    const sliceProgress = join(sliceRoot, "PROGRESS.md");
    writeFileSync(missionSpec, "---\nintent: Mission goal\n---\n", "utf8");
    writeFileSync(sliceSpec, "---\nintent: Slice goal\n---\n", "utf8");
    writeFileSync(missionProgress, "# Mission\n\n## Outcomes\n", "utf8");
    if (withProgress) writeFileSync(sliceProgress, "# Slice\n\n## Outcomes\n", "utf8");
    return {
      position: { workspaceRoot: root, projectId: "app", projectRoot: root, selectedBy: "single",
        missionRoot, sliceRoot, mission: "audit", slice: "01-goal", frontier: "slice" },
      pieces: [
        { altitude: "mission", address: "mission:SPEC.md", path: missionSpec, exists: true, source: "default" },
        { altitude: "mission", address: "mission:PROGRESS.md", path: missionProgress, exists: true, source: "default" },
        { altitude: "slice", address: "mission:slices/01-goal/SPEC.md", path: sliceSpec, exists: true, source: "explicit" },
        { altitude: "slice", address: "mission:slices/01-goal/PROGRESS.md", path: sliceProgress, exists: withProgress, source: "default" },
      ],
      systemWorld: { state: "default", source: "default", selection: "default", manifestPath: null, id: null, version: null, context: [], skills: [] },
      skills: [], derive: [], warnings: [],
    };
  }

  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it("records the actual result in the selected slice and is idempotent on replay", () => {
    work = makeWork();
    const outcome = { operation: "set" as const, seat: "audit-lead@kernel", threadId: "thread-1", changed: true, status: "active",
      objectiveSource: { altitude: "slice" as const, specPath: join(root, "missions/audit/slices/01-goal/SPEC.md"),
        specAddress: "mission:slices/01-goal/SPEC.md", selectionSource: "explicit" as const } };

    const first = recordSeatGoalOutcome(work, outcome);
    const replay = recordSeatGoalOutcome(work, outcome);

    expect(first.target).toMatchObject({ ok: true, scope: "slice", mission: "audit", slice: "01-goal" });
    expect(first.changed).toBe(true);
    expect(replay.changed).toBe(false);
    const sliceProgress = readFileSync(join(root, "missions/audit/slices/01-goal/PROGRESS.md"), "utf8");
    expect(sliceProgress.match(/Codex seat goal set:/g)).toHaveLength(1);
    expect(sliceProgress).toContain("set active");
    expect(sliceProgress).toContain("mission:slices/01-goal/SPEC.md");
    expect(readFileSync(join(root, "missions/audit/PROGRESS.md"), "utf8")).not.toContain("Codex seat goal");
  });

  it("refuses to mutate when the selected scope has no existing progress rail", () => {
    work = makeWork(false);
    const target = resolveSeatGoalTrailTarget(work);
    expect(target).toMatchObject({ ok: false, code: "goal_progress_unavailable" });
    expect(existsSync(join(root, "missions/audit/slices/01-goal/PROGRESS.md"))).toBe(false);
  });
});
