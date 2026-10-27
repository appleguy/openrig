import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { getNodeInventory } from "./node-inventory.js";
import { SeatStatusService } from "./seat-status-service.js";
import { GOAL_STATUSES, GoalControlError, type GoalChange } from "../adapters/codex-goal-client.js";

export class SeatGoalService {
  constructor(private deps: { rigRepo: RigRepository; sessionRegistry: SessionRegistry; runtimeAdapters?: Record<string, RuntimeAdapter> }) {}

  async control(seatRef: string, input: unknown) {
    const body = input as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["operation", "threadId", "socketPath", "objective", "status"].includes(key))
      || !["get", "set", "clear"].includes(String(body.operation))
      || typeof body.threadId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.threadId)
      || typeof body.socketPath !== "string" || !body.socketPath.startsWith("/")
      || body.operation === "set" && (!GOAL_STATUSES.includes(body.status as never)
        || body.objective !== undefined && (typeof body.objective !== "string" || !body.objective.trim()))
      || body.operation !== "set" && (body.status !== undefined || body.objective !== undefined)) {
      throw new GoalControlError("goal_input_invalid", "Supply operation get/set/clear, exact threadId and absolute socketPath; set requires status and optionally a nonempty objective");
    }
    const resolved = new SeatStatusService({ rigRepo: this.deps.rigRepo }).getStatus(seatRef);
    if (!resolved.ok) throw new GoalControlError(resolved.code, resolved.message);
    const { status } = resolved;
    const entry = getNodeInventory(this.deps.rigRepo.db, status.rig_id).find(row => row.logicalId === status.logical_id)!;
    const node = this.deps.rigRepo.getRig(status.rig_id)?.nodes.find(row => row.logicalId === status.logical_id);
    const adapter = node?.runtime ? this.deps.runtimeAdapters?.[node.runtime] : undefined;
    if (!adapter?.controlGoal) throw new GoalControlError("goal_unsupported", "This seat's runtime has no native goal-control adapter");
    const binding = node && this.deps.sessionRegistry.getBindingForNode(node.id);
    if (!binding?.tmuxPane || binding.tmuxSession !== entry.canonicalSessionName || entry.sessionStatus !== "running"
      || entry.resumeType !== "codex" || entry.resumeToken !== body.threadId) {
      throw new GoalControlError("goal_identity_unverified", "The live seat binding and saved thread do not match the supplied threadId");
    }
    const beforeMutation = async () => {
      const currentBinding = this.deps.sessionRegistry.getBindingForNode(node!.id);
      const current = getNodeInventory(this.deps.rigRepo.db, status.rig_id).find(row => row.logicalId === status.logical_id);
      if (!current || JSON.stringify(currentBinding) !== JSON.stringify(binding) || current.resumeToken !== body.threadId
        || current.sessionStatus !== "running" || current.canonicalSessionName !== entry.canonicalSessionName) {
        throw new GoalControlError("goal_identity_changed", "The seat binding or native thread changed before dispatch");
      }
    };
    const change: GoalChange = body.operation === "set" ? { operation: "set", status: body.status as never,
      ...(body.objective === undefined ? {} : { objective: body.objective as string }) } : { operation: body.operation as "get" | "clear" };
    const result = await adapter.controlGoal({ binding, threadId: body.threadId, socketPath: body.socketPath, change, beforeMutation });
    return { ok: true, seat: entry.canonicalSessionName, threadId: body.threadId, ...result };
  }
}
