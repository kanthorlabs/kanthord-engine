import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { workerKind } from "./worker.ts";

export const runDrivers = ["internal", "external"] as const;
export type RunDriver = (typeof runDrivers)[number];

export const runRow = z
  .object({
    id: identity("run"),
    kind: z.enum(["objective", "task"]),
    driver: z.enum(runDrivers),
    nodeId: nodeIdentity,
    parentRunId: identity("run").nullable(),
    workspaceId: identity("workspace").nullable(),
    worker: workerKind.nullable(),
    leaseFence: z.int(),
    attemptLimit: z.int(),
    baseOid: objectId.nullable(),
    headOid: objectId.nullable(),
    state: z.enum(["active", "ended"]),
    outcome: z.string().nullable(),
    endedAt: epochMillis.nullable(),
  })
  .refine((row) => (row.kind === "objective") === (row.parentRunId === null), {
    message: "(kind = 'objective') = (parent_run_id IS NULL)",
  })
  .refine(
    (row) =>
      row.driver === "internal"
        ? row.workspaceId !== null &&
          row.worker !== null &&
          row.baseOid !== null
        : row.workspaceId === null &&
          row.worker === null &&
          row.baseOid === null,
    {
      message:
        "(driver = 'internal') = (workspace_id IS NOT NULL AND worker IS NOT NULL AND base_oid IS NOT NULL)",
    },
  );
export type RunRow = z.infer<typeof runRow>;
