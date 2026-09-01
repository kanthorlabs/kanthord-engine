import { z } from "zod";

import { identity, nodeIdentity, parseIdentity } from "./identity.ts";
import { epochMillis } from "./column.ts";
import { nodeKind, nodeState, blockReason } from "./state.ts";
import { workerKind } from "./worker.ts";
import { blobHash } from "./blob.ts";
import { deliverable } from "./deliverable.ts";
import { nodePairLegality } from "./node-pair.ts";
import { workerId } from "./worker-id.ts";

export const nodeRow = z
  .object({
    id: nodeIdentity,
    projectId: identity("project"),
    kind: nodeKind,
    parentId: nodeIdentity.nullable(),
    title: z.string(),
    instructionBlob: blobHash,
    acceptanceBlob: blobHash.nullable(),
    worker: workerKind.nullable(),
    assignment: workerId.nullable(),
    repositoryId: identity("repository").nullable(),
    state: nodeState,
    blockReason: blockReason.nullable(),
    discardReason: z.string().nullable(),
    revision: identity("planRevision"),
    updatedAt: epochMillis,
    deliverable: deliverable.nullable(),
    verifyJson: z.string().nullable(),
  })
  .refine((row) => (row.kind === "initiative") === (row.parentId === null), {
    message: "(kind = 'initiative') = (parent_id IS NULL)",
  })
  .refine((row) => (row.kind === "objective") === (row.repositoryId !== null), {
    message: "(kind = 'objective') = (repository_id IS NOT NULL)",
  })
  .refine((row) => (row.kind === "task") === (row.acceptanceBlob !== null), {
    message: "(kind = 'task') = (acceptance_blob IS NOT NULL)",
  })
  .refine((row) => (row.state === "blocked") === (row.blockReason !== null), {
    message: "(state = 'blocked') = (block_reason IS NOT NULL)",
  })
  .refine(
    (row) => row.state !== "awaiting_approval" || row.kind === "objective",
    {
      message: "state <> 'awaiting_approval' OR kind = 'objective'",
    },
  )
  .refine((row) => row.state !== "partial" || row.kind !== "task", {
    message: "state <> 'partial' OR kind <> 'task'",
  })
  .refine((row) => parseIdentity(row.id)?.kind === row.kind, {
    message: "the id prefix names the node kind",
  })
  .refine(
    (row) => {
      if (row.deliverable === null) return true;
      return nodePairLegality(row.kind, row.deliverable).legal;
    },
    { message: "pair-illegal: kind and deliverable combination is not legal" },
  );
export type NodeRow = z.infer<typeof nodeRow>;
