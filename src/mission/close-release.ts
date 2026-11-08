import { asError } from "../kernel/errors.ts";
import type { ExecutionTrace } from "../tracking/contract.ts";
import { Act, type ActFacts, recordAct } from "./act-telemetry.ts";
import { NodeState, type ReleaseStop } from "./contract.ts";
import { discardNode, overrideNode } from "./control-close.ts";
import { executionEnds, reportEnds } from "./control.ts";
import { finishEvidenceDelete } from "./evidence-delete.ts";
import { requireNode } from "./node-read.ts";
import {
  holdsStepOne,
  type PendingClose,
  type PendingCloses,
} from "./pending-close.ts";
import type { Dependencies } from "./service.ts";
import { requireMission } from "./write.ts";

const CLOSE_DROPPED = "mission.node.close_dropped";

type PendingNodeClose = Exclude<
  PendingClose,
  { act: typeof Act.DeleteEvidence }
>;

function dropped(
  dependencies: Dependencies,
  pending: PendingClose,
  error?: unknown,
): void {
  dependencies.logger.warn(
    {
      node_id: pending.node_id,
      act: pending.act,
      ...(error === undefined ? {} : { err: asError(error) }),
    },
    CLOSE_DROPPED,
  );
}

function stepOneLink(pending: PendingClose): ExecutionTrace | null {
  if (pending.trace === null) return null;
  return {
    execution_id: pending.execution_id,
    project_id: pending.trace.project_id,
    node_id: pending.node_id,
    attempt: pending.attempt,
    trace_id: pending.trace.trace_id,
    root_span_id: pending.trace.root_span_id,
  };
}

function closeNode(
  dependencies: Dependencies,
  pending: PendingNodeClose,
): void {
  const ends = executionEnds();
  const now = Date.now();
  const acted = dependencies.store.transaction((tx) => {
    const { mission_id } = requireNode(tx, pending.node_id);
    const checks = {
      expected_mission_version: requireMission(tx, mission_id).version,
      expected_state: NodeState.Paused,
      expected_attempt: pending.attempt,
    };
    return pending.act === Act.Override
      ? overrideNode(
          tx,
          dependencies,
          pending.node_id,
          { ...pending.body, ...checks },
          pending.actor,
          now,
          ends,
        )
      : discardNode(
          tx,
          dependencies,
          pending.node_id,
          { ...pending.body, ...checks },
          pending.actor,
          now,
          ends,
        );
  });
  reportEnds(dependencies, ends);
  const facts: ActFacts = {
    ...acted.act,
    revoked: acted.act.revoked ?? stepOneLink(pending),
  };
  recordAct(dependencies, pending.act, facts);
  dependencies.wakeup.wake(acted.act.project_id);
}

export function executionReleased(
  dependencies: Dependencies,
  closes: PendingCloses,
  executionId: string,
  stop: ReleaseStop | null,
): void {
  void stop;
  const pending = closes.take(executionId);
  if (pending === null) return;
  try {
    if (!dependencies.store.transaction((tx) => holdsStepOne(tx, pending)))
      return dropped(dependencies, pending);
    if (pending.act !== Act.DeleteEvidence)
      return closeNode(dependencies, pending);
    finishEvidenceDelete(dependencies, pending).catch((error: unknown) =>
      dropped(dependencies, pending, error),
    );
  } catch (error) {
    dropped(dependencies, pending, error);
  }
}
