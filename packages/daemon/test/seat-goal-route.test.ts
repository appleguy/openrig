import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const threadId = "01a179a1-9ac1-7cf1-b249-4acf7d07868a";
describe("native seat goal route", () => {
  const db = createFullTestDb();
  const controlGoal = vi.fn(async (input: Parameters<NonNullable<RuntimeAdapter["controlGoal"]>>[0]) => {
    await input.beforeMutation(); return { goal: null, changed: false };
  });
  const setup = createTestApp(db, { adapters: { codex: { runtime: "codex", controlGoal } as unknown as RuntimeAdapter } });
  const rig = setup.rigRepo.createRig("goal-test");
  const node = setup.rigRepo.addNode(rig.id, "audit.lead", { runtime: "codex" });
  const session = setup.sessionRegistry.registerSession(node.id, "audit-lead@goal-test");
  setup.sessionRegistry.updateStatus(session.id, "running");
  setup.sessionRegistry.updateResumeToken(session.id, "codex_id", threadId, "operator");
  setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "audit-lead@goal-test", tmuxPane: "%1" });
  beforeEach(() => { setup.sessionRegistry.updateResumeToken(session.id, "codex_id", threadId, "operator"); });
  afterEach(() => { controlGoal.mockClear(); });
  const post = (body: unknown) => setup.app.request("/api/seat/goal/audit-lead%40goal-test", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  it("routes explicit target and authored objective provenance through the existing goal service", async () => {
    const objectiveSource = { altitude: "slice", specPath: "/work/missions/audit/slices/01-goal/SPEC.md",
      specAddress: "mission:slices/01-goal/SPEC.md", selectionSource: "explicit" };
    const res = await post({ operation: "set", threadId, socketPath: "/target/rpc.sock", status: "active",
      objective: "Slice objective", objectiveSource });
    expect(res.status).toBe(200);
    expect(controlGoal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId, socketPath: "/target/rpc.sock",
      binding: expect.objectContaining({ tmuxPane: "%1" }), change: { operation: "set", status: "active", objective: "Slice objective" } }));
    expect(await res.json()).toMatchObject({ objectiveSource });
  });
  it("defaults thread identity from the target seat and leaves endpoint resolution to its bound process", async () => {
    const res = await post({ operation: "get" });
    expect(res.status).toBe(200);
    expect(controlGoal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId, binding: expect.objectContaining({ tmuxPane: "%1" }) }));
    expect(controlGoal.mock.calls[0]![0].socketPath).toBeUndefined();
  });
  it("refuses stale occupant and malformed requests before adapter dispatch", async () => {
    expect((await post({ operation: "clear", threadId: "01a179a1-0000-0000-0000-000000000000", socketPath: "/target/rpc.sock" })).status).toBe(409);
    expect((await post({ operation: "set", threadId, socketPath: "/target/rpc.sock", status: "bogus" })).status).toBe(400);
    expect(controlGoal).not.toHaveBeenCalled();
  });
  it("refuses a non-Codex resume type before adapter dispatch", async () => {
    setup.sessionRegistry.updateResumeToken(session.id, "claude_id", threadId, "operator");
    expect((await post({ operation: "get", threadId, socketPath: "/target/rpc.sock" })).status).toBe(409);
    expect(controlGoal).not.toHaveBeenCalled();
  });
});
