import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveSeatGoalObjective } from "../src/lib/seat-goal-objective.js";
import { resolveWorkPosition } from "../src/lib/work-install.js";
import type { WorkInstallPlan } from "../src/lib/work-install.js";

describe("seat goal objective resolution", () => {
  let root: string;
  let workspaceRoot: string;
  let projectRoot: string;
  let contextRoot: string;

  function makeWorkspace(): void {
    root = mkdtempSync(join(tmpdir(), "openrig-seat-goal-objective-"));
    workspaceRoot = join(root, "workspace");
    projectRoot = join(root, "project");
    contextRoot = join(root, "context");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(contextRoot, "system"), { recursive: true });
    writeFileSync(join(workspaceRoot, "workspace.yaml"), `schema: openrig.workspace/v0alpha1
projects:
  - id: app
    root: ${relative(workspaceRoot, projectRoot)}
`);
    writeFileSync(join(projectRoot, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
id: app
`);
    writeFileSync(join(projectRoot, "SPEC.md"), `---
intent: Project intent must never be used as a mission objective
---
`);
    writeFileSync(join(contextRoot, "system", "system-world.yaml"), `schema: openrig.system-world/v0alpha1
id: test-default
version: "0.5.9"
context:
  - ref: onboarding-width
skills: []
`);
    mkdirSync(join(projectRoot, "missions", "audit", "slices"), { recursive: true });
  }

  function writeMissionSpec(body: string): string {
    const missionRoot = join(projectRoot, "missions", "audit");
    writeFileSync(join(missionRoot, "SPEC.md"), body);
    return realpathSync(join(missionRoot, "SPEC.md"));
  }

  function writeSlice(name: string, body?: string): string {
    const sliceRoot = join(projectRoot, "missions", "audit", "slices", name);
    mkdirSync(sliceRoot, { recursive: true });
    if (body !== undefined) writeFileSync(join(sliceRoot, "SPEC.md"), body);
    return join(realpathSync(sliceRoot), "SPEC.md");
  }

  function position(mission?: string, slice?: string): WorkInstallPlan | { error: { code: string; message: string; candidates?: string[] } } {
    return resolveWorkPosition({
      workspaceRoot,
      contextRoot,
      systemWorldSelection: "default",
      systemWorldSource: "default",
      ...(mission !== undefined ? { mission } : {}),
      ...(slice !== undefined ? { slice } : {}),
    });
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("uses the selected slice intent and returns its exact SPEC provenance", () => {
    makeWorkspace();
    const missionSpec = writeMissionSpec("---\nintent: Mission objective\n---\n");
    const sliceSpec = writeSlice("01-selected", "---\nintent: Slice objective\n---\n");
    const selected = position("audit", "01-selected");

    const result = resolveSeatGoalObjective(selected);

    expect(result).toEqual({
      ok: true,
      objective: "Slice objective",
      source: {
        altitude: "slice",
        specPath: sliceSpec,
        specAddress: "mission:slices/01-selected/SPEC.md",
        selectionSource: "explicit",
      },
    });
    expect(result.ok && result.source.specPath).not.toBe(missionSpec);
  });

  it("falls back to selected mission intent when a resolved slice has none", () => {
    makeWorkspace();
    const missionSpec = writeMissionSpec("---\nintent: Mission objective\n---\n");
    const sliceSpec = writeSlice("01-selected", "---\nid: SCN.1\n---\n");
    const selected = position("audit", "01-selected");

    const result = resolveSeatGoalObjective(selected);

    expect(result).toEqual({
      ok: true,
      objective: "Mission objective",
      source: {
        altitude: "mission",
        specPath: missionSpec,
        specAddress: "mission:SPEC.md",
        selectionSource: "default",
      },
      fallback: {
        from: {
          altitude: "slice",
          specPath: sliceSpec,
          specAddress: "mission:slices/01-selected/SPEC.md",
          selectionSource: "explicit",
        },
        reason: "intent_missing",
      },
    });
  });

  it("reports a missing slice SPEC as explicit fallback provenance", () => {
    makeWorkspace();
    const missionSpec = writeMissionSpec("---\nintent: Mission objective\n---\n");
    const missingSliceSpec = writeSlice("01-selected");
    const selected = position("audit", "01-selected");

    const result = resolveSeatGoalObjective(selected);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.objective).toBe("Mission objective");
    expect(result.source.specPath).toBe(missionSpec);
    expect(result.fallback).toEqual({
      from: {
        altitude: "slice",
        specPath: missingSliceSpec,
        specAddress: "mission:slices/01-selected/SPEC.md",
        selectionSource: "explicit",
      },
      reason: "spec_missing",
    });
  });

  it("does not substitute project intent when mission scope is absent or unresolved", () => {
    makeWorkspace();

    const noMission = resolveSeatGoalObjective(position());
    const missingMission = resolveSeatGoalObjective(position("missing"));

    expect(noMission).toMatchObject({ ok: false, error: { code: "goal_scope_missing" } });
    expect(missingMission).toMatchObject({ ok: false, error: { code: "goal_mission_unresolved" } });
  });

  it("preserves native missing and ambiguous selection errors", () => {
    makeWorkspace();
    writeMissionSpec("---\nintent: Mission objective\n---\n");
    const missingSlice = resolveSeatGoalObjective(position("audit", "absent"));
    writeSlice("01-one", "---\nid: same-id\n---\n");
    writeSlice("02-two", "---\nid: same-id\n---\n");
    const ambiguousSlice = resolveSeatGoalObjective(position("audit", "same-id"));

    expect(missingSlice).toMatchObject({ ok: false, error: { code: "slice_not_found" } });
    expect(ambiguousSlice).toMatchObject({ ok: false, error: { code: "slice_identity_ambiguous" } });
  });

  it("requires authored mission intent when no selected slice supplies it", () => {
    makeWorkspace();
    writeMissionSpec("# Mission without authored intent\n");
    writeSlice("01-selected", "---\nintent: \n---\n");

    const result = resolveSeatGoalObjective(position("audit", "01-selected"));

    expect(result).toMatchObject({ ok: false, error: { code: "goal_objective_missing" } });
    expect(result.ok ? "" : result.error.message).toContain("missions/audit/SPEC.md");
    expect(result.ok ? "" : result.error.message).toContain("missions/audit/slices/01-selected/SPEC.md");
  });
});
