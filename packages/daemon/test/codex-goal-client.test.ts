import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { WebSocketServer } from "ws";
import { CodexGoalClient, type NativeGoal } from "../src/adapters/codex-goal-client.js";

const thread = "01a179a1-9ac1-7cf1-b249-4acf7d07868a";
describe("Codex native goals over an existing Unix WebSocket", () => {
  let server: Server, wss: WebSocketServer, dir: string, socket: string;
  let goal: NativeGoal | null;
  let calls: Array<{ method: string; params: Record<string, unknown> }>;
  let loseMutationReply: boolean;
  let wrongThread: boolean;
  let client: CodexGoalClient | undefined;
  beforeEach(async () => {
    dir = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/openrig-goal-"); socket = `${dir}/rpc.sock`;
    calls = []; loseMutationReply = false; wrongThread = false;
    goal = { threadId: thread, objective: "Preserve the full audit", status: "paused", tokensUsed: 123, tokenBudget: 999 };
    server = createServer(); wss = new WebSocketServer({ server });
    wss.on("connection", ws => ws.on("message", bytes => {
      const request = JSON.parse(bytes.toString()); calls.push(request);
      if (!request.id) return;
      let result: unknown = {};
      if (request.method === "thread/goal/get") result = { goal: wrongThread && goal ? { ...goal, threadId: "wrong" } : goal };
      if (request.method === "thread/goal/set") goal = { ...goal!, ...request.params };
      if (request.method === "thread/goal/clear") { goal = null; result = { cleared: true }; }
      if (loseMutationReply && ["thread/goal/set", "thread/goal/clear"].includes(request.method)) { ws.terminate(); return; }
      ws.send(JSON.stringify({ id: request.id, result }));
    }));
    await new Promise<void>(resolve => server.listen(socket, resolve));
  });
  afterEach(async () => {
    client?.close(); client = undefined;
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
  });
  it("initializes, changes status only, verifies readback and never starts a turn", async () => {
    client = await CodexGoalClient.connect(socket);
    const result = await client.apply(thread, { operation: "set", status: "active" }, async () => {});
    expect(result).toMatchObject({ changed: true, goal: { objective: "Preserve the full audit", tokensUsed: 123, tokenBudget: 999, status: "active" } });
    expect(calls.map(call => call.method)).toEqual(["initialize", "initialized", "thread/goal/get", "thread/goal/set", "thread/goal/get"]);
    expect(calls[3]!.params).toEqual({ threadId: thread, status: "active" });
  });
  it("preserves a complete multiline objective and native accounting on exact readback", async () => {
    client = await CodexGoalClient.connect(socket);
    const objective = "first line\n\nsecond line\n";
    const result = await client.apply(thread, { operation: "set", status: "paused", objective }, async () => {});
    expect(calls.find(call => call.method === "thread/goal/set")?.params).toEqual({ threadId: thread, status: "paused", objective });
    expect(result.goal).toMatchObject({ threadId: thread, status: "paused", objective, tokensUsed: 123, tokenBudget: 999 });
  });
  it("does not reactivate identical repeated requests", async () => {
    client = await CodexGoalClient.connect(socket);
    await client.apply(thread, { operation: "set", status: "active" }, async () => {});
    expect((await client.apply(thread, { operation: "set", status: "active" }, async () => { throw new Error("must not mutate"); })).changed).toBe(false);
    expect(calls.filter(call => call.method === "thread/goal/set")).toHaveLength(1);
  });
  it("retains an uncertain mutation as unknown and never replays it", async () => {
    client = await CodexGoalClient.connect(socket); loseMutationReply = true;
    await expect(client.apply(thread, { operation: "set", status: "active" }, async () => {})).rejects.toMatchObject({ code: "goal_outcome_unknown", outcomeUnknown: true });
    expect(goal?.status).toBe("active");
    expect(calls.filter(call => call.method === "thread/goal/set")).toHaveLength(1);
  });
  it("refuses a different native thread before mutation", async () => {
    client = await CodexGoalClient.connect(socket); wrongThread = true;
    await expect(client.apply(thread, { operation: "clear" }, async () => {})).rejects.toMatchObject({ code: "goal_readback_invalid" });
    expect(calls.some(call => call.method === "thread/goal/clear")).toBe(false);
  });
  it("rechecks binding before dispatch and clears with readback", async () => {
    client = await CodexGoalClient.connect(socket);
    await expect(client.apply(thread, { operation: "clear" }, async () => { throw new Error("binding changed"); })).rejects.toThrow("binding changed");
    expect(goal).not.toBeNull();
    expect(await client.apply(thread, { operation: "clear" }, async () => {})).toEqual({ changed: true, goal: null });
  });
});
