import type { EventLog } from "../../services/event/index.ts";
import type { Transaction } from "../../services/storage/index.ts";

export type ExpireRunsInput = Readonly<{ now: number }>;

export type ExpiredRun = Readonly<{
  runId: string;
  nodeId: string;
  fence: number;
}>;

type ExecutionExpiry = Readonly<{
  expireDueRuns(
    transaction: Transaction,
    input: ExpireRunsInput,
  ): readonly ExpiredRun[];
}>;

export type ExpireRunsDependencies = Readonly<{
  events: EventLog;
  execution: ExecutionExpiry;
  instanceId: string;
}>;

export function expireRuns(
  dependencies: ExpireRunsDependencies,
  transaction: Transaction,
  input: ExpireRunsInput,
): readonly ExpiredRun[] {
  const rows = dependencies.execution.expireDueRuns(transaction, input);

  for (const row of rows) {
    dependencies.events.append(transaction, {
      subjectKind: "run",
      subjectId: row.runId,
      type: "run.expired",
      actorKind: "daemon",
      actorId: dependencies.instanceId,
      payload: {
        runId: row.runId,
        nodeId: row.nodeId,
        fence: row.fence,
        expiredAt: input.now,
      },
    });
  }

  return rows.map((row) => ({
    runId: row.runId,
    nodeId: row.nodeId,
    fence: row.fence,
  }));
}
