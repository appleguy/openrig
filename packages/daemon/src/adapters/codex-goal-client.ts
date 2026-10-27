import WebSocket from "ws";

export const GOAL_STATUSES = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];
export interface NativeGoal {
  threadId: string;
  objective: string;
  status: GoalStatus;
  [key: string]: unknown;
}
export type GoalChange = { operation: "get" } | { operation: "clear" } |
  { operation: "set"; objective?: string; status: GoalStatus };

export class GoalControlError extends Error {
  constructor(readonly code: string, message: string, readonly outcomeUnknown = false) { super(message); }
}

/** A connection to an EXISTING server. Never launches/resumes a thread or retries a mutation. */
export class CodexGoalClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private ws: WebSocket, private timeoutMs: number) {
    ws.on("message", bytes => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(bytes.toString()); } catch { this.fail(new Error("Invalid Codex JSON-RPC response")); return; }
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new GoalControlError("goal_rpc_rejected", message.error.message ?? "Codex rejected goal request"));
      else request.resolve(message.result);
    });
    ws.on("error", error => this.fail(error));
    ws.on("close", () => this.fail(new Error("Codex goal connection closed")));
  }

  static async connect(socket: string, timeoutMs = 3000): Promise<CodexGoalClient> {
    if (!socket.startsWith("/") || socket.includes(":")) throw new GoalControlError("goal_endpoint_invalid", "An absolute Unix socket path without ':' is required");
    const ws = new WebSocket(`ws+unix://${socket}:/`, { handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024 });
    const client = new CodexGoalClient(ws, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      await client.request("initialize", { clientInfo: { name: "openrig", title: "OpenRig seat goal control", version: "1" } });
      ws.send(JSON.stringify({ method: "initialized" }));
      return client;
    } catch (error) { client.close(); throw error; }
  }

  private fail(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} response timed out`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        const item = this.pending.get(id);
        if (item) { clearTimeout(item.timer); this.pending.delete(id); item.reject(error); }
      });
    });
  }

  async get(threadId: string): Promise<NativeGoal | null> {
    const result = await this.request("thread/goal/get", { threadId }) as { goal?: NativeGoal | null };
    if (!result || !("goal" in result) || result.goal !== null && (!result.goal || result.goal.threadId !== threadId
      || typeof result.goal.objective !== "string" || !GOAL_STATUSES.includes(result.goal.status))) {
      throw new GoalControlError("goal_readback_invalid", "Codex returned an invalid goal or a different thread");
    }
    return result.goal;
  }

  async apply(threadId: string, change: GoalChange, beforeMutation: () => Promise<void>): Promise<{ goal: NativeGoal | null; changed: boolean }> {
    const before = await this.get(threadId);
    if (change.operation === "get") return { goal: before, changed: false };
    if (change.operation === "clear" && before === null) return { goal: null, changed: false };
    if (change.operation === "set" && before && before.status === change.status
      && (change.objective === undefined || before.objective === change.objective)) return { goal: before, changed: false };
    if (change.operation === "set" && change.objective === undefined && before === null) {
      throw new GoalControlError("goal_absent", "No goal exists to change status; supply an objective");
    }
    await beforeMutation();
    try {
      await this.request(`thread/goal/${change.operation}`, { threadId, ...(change.operation === "set"
        ? { status: change.status, ...(change.objective === undefined ? {} : { objective: change.objective }) } : {}) });
    } catch (error) {
      if (error instanceof GoalControlError && error.code === "goal_rpc_rejected") throw error;
      throw new GoalControlError("goal_outcome_unknown", `Goal mutation acknowledgement is uncertain: ${(error as Error).message}. Read the goal before any retry.`, true);
    }
    try {
      const goal = await this.get(threadId);
      if (change.operation === "clear" ? goal !== null : !goal || goal.status !== change.status
        || goal.objective !== (change.objective ?? before?.objective)) throw new Error("Goal differs from the requested state");
      return { goal, changed: true };
    } catch (error) { throw new GoalControlError("goal_outcome_unknown", `Mutation acknowledged, but readback failed: ${(error as Error).message}. Read the goal before any retry.`, true); }
  }

  close(): void { this.ws.terminate(); }
}
