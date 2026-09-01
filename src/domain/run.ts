import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis, objectId } from "./column.ts";
import { runKinds } from "./run-kind.ts";
import { workerId } from "./worker-id.ts";

export const runDrivers = ["internal", "external"] as const;
export type RunDriver = (typeof runDrivers)[number];

export const runningReasons = ["claim-taken", "child-started"] as const;

export const runRow = z
  .object({
    id: identity("run"),
    kind: z.enum(runKinds),
    driver: z.enum(runDrivers),
    nodeId: nodeIdentity,
    workspaceId: identity("workspace").nullable(),
    worker: workerId,
    fence: z.int().min(1),
    attemptLimit: z.int(),
    headOid: objectId.nullable(),
    judgedOid: objectId.nullable(),
    graphRevision: identity("planRevision").nullable(),
    agents: z.array(workerId),
    expiresAt: epochMillis,
    maxLifetimeAt: epochMillis,
    state: z.enum(["active", "ended"]),
    outcome: z.string().nullable(),
    endedAt: epochMillis.nullable(),
    baseCount: z.int().min(0),
  })
  .refine(
    (row) =>
      row.kind === "execution"
        ? row.baseCount <= 1
        : row.kind === "structural" || row.kind === "review"
          ? row.baseCount === 0
          : true,
    {
      message:
        "an execution run holds at most one run_base row, and a structural or review run holds none",
    },
  );
export type RunRow = z.infer<typeof runRow>;

export const runBaseRow = z.object({
  runId: identity("run"),
  repositoryId: identity("repository"),
  oid: objectId,
});
export type RunBaseRow = z.infer<typeof runBaseRow>;
