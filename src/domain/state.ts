import { z } from "zod";

export const nodeKinds = ["initiative", "objective", "task"] as const;
export const nodeKind = z.enum(nodeKinds);
export type NodeKind = z.infer<typeof nodeKind>;

export const nodeStates = [
  "pending",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
  "done",
  "partial",
  "discarded",
] as const;
export const nodeState = z.enum(nodeStates);
export type NodeState = z.infer<typeof nodeState>;

export const terminalStates = ["done", "partial", "discarded"] as const;
export type TerminalState = (typeof terminalStates)[number];

export const blockReasons = [
  "attempt-limit",
  "dependency-discarded",
  "stale-base",
  "dirty-recovery",
  "e2e-failed",
  "abandoned",
] as const;
export const blockReason = z.enum(blockReasons);
export type BlockReason = z.infer<typeof blockReason>;
