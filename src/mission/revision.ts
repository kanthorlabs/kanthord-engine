import { revisionSchema, type Revision } from "./contract.ts";
import type { RevisionRow } from "./store.ts";

export function revisionFromRow(row: RevisionRow): Revision {
  return revisionSchema.parse({
    nodeId: row.node_id,
    filename: row.filename,
    revision: row.revision,
    reason: row.reason,
    actor: JSON.parse(row.actor),
    createdAt: row.created_at,
    content: {
      name: row.name,
      requirement: row.requirement,
      criterion: row.criterion,
      verifications: JSON.parse(row.verifications),
      bindings: JSON.parse(row.bindings),
    },
    ...(row.tasks === null ? {} : { tasks: JSON.parse(row.tasks) }),
    change: JSON.parse(row.change),
    pinnedByAttempts: [],
  });
}
