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
      || Object.keys(body).some(key => !["operation", "threadId", "socketPath", "objective", "objectiveSource", "status"].includes(key))
      || !["get", "set", "clear"].includes(String(body.operation))
      || body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.threadId))
      || body.socketPath !== undefined && (typeof body.socketPath !== "string" || !body.socketPath.startsWith("/"))
      || body.operation === "set" && (!GOAL_STATUSES.includes(body.status as never)
        || body.objective !== undefined && (typeof body.objective !== "string" || !body.objective.trim()))
      || body.operation === "set" && body.objectiveSource !== undefined && (body.objective === undefined || !isGoalObjectiveMetadata(body.objectiveSource))
      || body.operation !== "set" && (body.status !== undefined || body.objective !== undefined || body.objectiveSource !== undefined)) {
      throw new GoalControlError("goal_input_invalid", "Supply operation get/set/clear, optional exact threadId/socketPath; set requires status and optionally a nonempty objective with valid source metadata");
    }
    const resolved = new SeatStatusService({ rigRepo: this.deps.rigRepo }).getStatus(seatRef);
    if (!resolved.ok) throw new GoalControlError(resolved.code, resolved.message);
    const { status } = resolved;
    const entry = getNodeInventory(this.deps.rigRepo.db, status.rig_id).find(row => row.logicalId === status.logical_id)!;
    const node = this.deps.rigRepo.getRig(status.rig_id)?.nodes.find(row => row.logicalId === status.logical_id);
    const adapter = node?.runtime ? this.deps.runtimeAdapters?.[node.runtime] : undefined;
    if (!adapter?.controlGoal) throw new GoalControlError("goal_unsupported", "This seat's runtime has no native goal-control adapter");
    const binding = node && this.deps.sessionRegistry.getBindingForNode(node.id);
    const threadId = typeof body.threadId === "string" ? body.threadId : entry.resumeToken;
    if (!binding?.tmuxPane || binding.tmuxSession !== entry.canonicalSessionName || entry.sessionStatus !== "running"
      || entry.resumeType !== "codex_id" || typeof threadId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)
      || entry.resumeToken !== threadId) {
      throw new GoalControlError("goal_identity_unverified", "The live seat binding and saved Codex thread could not be verified for this target");
    }
    const beforeMutation = async () => {
      const currentBinding = this.deps.sessionRegistry.getBindingForNode(node!.id);
      const current = getNodeInventory(this.deps.rigRepo.db, status.rig_id).find(row => row.logicalId === status.logical_id);
      if (!current || JSON.stringify(currentBinding) !== JSON.stringify(binding) || current.resumeToken !== threadId
        || current.sessionStatus !== "running" || current.canonicalSessionName !== entry.canonicalSessionName) {
        throw new GoalControlError("goal_identity_changed", "The seat binding or native thread changed before dispatch");
      }
    };
    const change: GoalChange = body.operation === "set" ? { operation: "set", status: body.status as never,
      ...(body.objective === undefined ? {} : { objective: body.objective as string }) } : { operation: body.operation as "get" | "clear" };
    const result = await adapter.controlGoal({ binding, threadId,
      ...(typeof body.socketPath === "string" ? { socketPath: body.socketPath } : {}), change, beforeMutation });
    return { ok: true, seat: entry.canonicalSessionName, threadId,
      ...(body.objectiveSource !== undefined ? { objectiveSource: body.objectiveSource } : {}), ...result };
  }
}

function isGoalObjectiveMetadata(value: unknown): boolean {
  if (!isRecord(value) || !["mission", "slice"].includes(String(value.altitude))
    || typeof value.specPath !== "string" || !value.specPath.startsWith("/")
    || typeof value.specAddress !== "string" || !value.specAddress.startsWith("mission:")
    || !["explicit", "manifest", "default"].includes(String(value.selectionSource))) return false;
  if (value.fallback === undefined) return true;
  const fallback = value.fallback;
  if (!isRecord(fallback) || !["spec_missing", "intent_missing", "intent_invalid"].includes(String(fallback.reason))) return false;
  const from = fallback.from;
  return isRecord(from) && ["mission", "slice"].includes(String(from.altitude))
    && typeof from.specPath === "string" && from.specPath.startsWith("/")
    && typeof from.specAddress === "string" && from.specAddress.startsWith("mission:")
    && ["explicit", "manifest", "default"].includes(String(from.selectionSource));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
