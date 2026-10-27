import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { getNodeDetail, getNodeInventory } from "../src/domain/node-inventory.js";

function seedKernelClaudeSeat(
  db: Database.Database,
  input: { nodeId: string; logicalId: string; sessionName: string; resumeToken: string | null; permissionMode: string },
) {
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.nodeId, "kernel", input.logicalId, "claude-code", "/workspace", "pod", "local:agent", "default");
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, resume_type, resume_token) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`session-${input.nodeId}`, input.nodeId, input.sessionName, "running", "ready", "claude_id", input.resumeToken);
  db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)")
    .run(`binding-${input.nodeId}`, input.nodeId, input.sessionName);
  new NativePermissionStore(db).write(
    input.nodeId,
    { runtime: "claude-code", mode: input.permissionMode },
    "test",
    "recovery command regression",
  );
}

describe("Claude recovery command projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("kernel", "kernel");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod", "kernel", "audit", "Audit");
  });

  afterEach(() => {
    db.close();
  });

  it("uses each kernel Claude seat's saved permission mode and Remote Control in both recovery views", () => {
    seedKernelClaudeSeat(db, {
      nodeId: "advisor",
      logicalId: "advisor.lead",
      sessionName: "advisor-lead@kernel",
      resumeToken: "advisor-thread",
      permissionMode: "full_bypass",
    });
    seedKernelClaudeSeat(db, {
      nodeId: "operator",
      logicalId: "operator.agent",
      sessionName: "operator-agent@kernel",
      resumeToken: "operator-thread",
      permissionMode: "bypassPermissions",
    });

    const expected = new Map([
      ["advisor.lead", { command: "claude --dangerously-skip-permissions --remote-control --resume 'advisor-thread'", name: "advisor-lead@kernel" }],
      ["operator.agent", { command: "claude --permission-mode bypassPermissions --remote-control --resume 'operator-thread'", name: "operator-agent@kernel" }],
    ]);
    const entries = getNodeInventory(db, "kernel");

    for (const [logicalId, { command, name }] of expected) {
      expect(entries.find((entry) => entry.logicalId === logicalId)?.resumeCommand).toBe(command);
      expect(getNodeDetail(db, "kernel", logicalId)?.recoveryGuidance?.commands).toContain(`${command} --name '${name}'`);
    }
  });

  it("keeps the permission mode and Remote Control on the Claude picker fallback", () => {
    seedKernelClaudeSeat(db, {
      nodeId: "operator",
      logicalId: "operator.agent",
      sessionName: "operator-agent@kernel",
      resumeToken: null,
      permissionMode: "bypassPermissions",
    });

    const entry = getNodeInventory(db, "kernel").find((node) => node.logicalId === "operator.agent");
    const guidance = getNodeDetail(db, "kernel", "operator.agent")?.recoveryGuidance;

    expect(entry?.resumeCommand).toBeNull();
    expect(guidance?.commands).toContain("claude --permission-mode bypassPermissions --remote-control --resume");
  });
});
