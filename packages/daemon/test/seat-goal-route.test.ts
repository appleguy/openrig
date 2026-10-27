import { afterEach, describe, expect, it, vi } from "vitest";
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
  setup.sessionRegistry.updateResumeToken(session.id, "codex", threadId, "operator");
  setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "audit-lead@goal-test", tmuxPane: "%1" });
  afterEach(() => { controlGoal.mockClear(); });
  const post = (body: unknown) => setup.app.request("/api/seat/goal/audit-lead%40goal-test", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  it("routes exact verified binding and status-only intent to the runtime adapter", async () => {
    const res = await post({ operation: "set", threadId, socketPath: "/target/rpc.sock", status: "active" });
    expect(res.status).toBe(200);
    expect(controlGoal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId, binding: expect.objectContaining({ tmuxPane: "%1" }), change: { operation: "set", status: "active" } }));
  });
  it("refuses stale occupant and malformed requests before adapter dispatch", async () => {
    expect((await post({ operation: "clear", threadId: "01a179a1-0000-0000-0000-000000000000", socketPath: "/target/rpc.sock" })).status).toBe(409);
    expect((await post({ operation: "set", threadId, socketPath: "/target/rpc.sock", status: "bogus" })).status).toBe(400);
    expect(controlGoal).not.toHaveBeenCalled();
  });
});
