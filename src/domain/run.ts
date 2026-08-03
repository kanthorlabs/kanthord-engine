import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { workerKind } from "./worker.ts";

export const runRow = z
  .object({
    id: identity("run"),
    kind: z.enum(["objective", "task"]),
    nodeId: nodeIdentity,
    parentRunId: identity("run").nullable(),
    workspaceId: identity("workspace"),
    worker: workerKind,
    leaseFence: z.int(),
    attemptLimit: z.int(),
    baseOid: objectId,
    headOid: objectId.nullable(),
    state: z.enum(["active", "ended"]),
    outcome: z.string().nullable(),
    endedAt: epochMillis.nullable(),
  })
  .refine((row) => (row.kind === "objective") === (row.parentRunId === null), {
    message: "(kind = 'objective') = (parent_run_id IS NULL)",
  });
export type RunRow = z.infer<typeof runRow>;
