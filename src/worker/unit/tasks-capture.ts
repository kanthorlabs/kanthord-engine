import { join } from "node:path";
import { withoutEnvironmentMaps } from "../contract.ts";
import type { ExecutionCtx } from "./chain.ts";
import { writeSeed } from "./tasks-seed-file.ts";

export const CAPTURE_VARIABLE = "KANTHORD_CAPTURE_TASKS";
export const CAPTURES_DIRECTORY = "captures";
const CAPTURE_ON = "1";
const NO_ELAPSED_MS = 0;

export type TasksCapture = (ctx: ExecutionCtx) => Promise<void>;

type CaptureKeys = Pick<
  ExecutionCtx,
  "claim" | "setup" | "revision" | "prior" | "state" | "plan"
>;

function capturedSeed(ctx: CaptureKeys, now: number): unknown {
  const { claim, state, plan } = ctx;
  return {
    claim: {
      execution_id: claim.execution_id,
      node_id: claim.node_id,
      attempt: claim.attempt,
      pinned_revision: claim.pinned_revision,
      node_branch: claim.node_branch,
      created_at: claim.created_at,
      expired_at: claim.expired_at,
      trace_id: claim.trace_id,
      root_span_id: claim.root_span_id,
    },
    setup: withoutEnvironmentMaps(ctx.setup),
    revision: ctx.revision,
    heads: Object.fromEntries(
      state.checkouts.map(({ binding_id, head }) => [binding_id, head]),
    ),
    prior: ctx.prior,
    affectedTests: state.affectedTests,
    plan: {
      pending: plan.pending.map(({ task, instruction }) => ({
        unit_id: task.id,
        instruction,
      })),
      node:
        plan.node === null
          ? null
          : { text: plan.node.text, round: plan.node.round },
    },
    elapsed_ms: Math.max(NO_ELAPSED_MS, now - claim.created_at),
  };
}

export function tasksCapture(dataDirectory: string): TasksCapture {
  return async (ctx) => {
    writeSeed(
      join(dataDirectory, CAPTURES_DIRECTORY, ctx.claim.execution_id),
      JSON.parse(JSON.stringify(capturedSeed(ctx, Date.now()))),
    );
  };
}

export function captureOf(
  env: NodeJS.ProcessEnv,
  dataDirectory: string,
): TasksCapture | undefined {
  return env[CAPTURE_VARIABLE] === CAPTURE_ON
    ? tasksCapture(dataDirectory)
    : undefined;
}
