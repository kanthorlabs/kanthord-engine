import { revisionSchema, type Revision } from "./contract.ts";
import type { RevisionRow } from "./store.ts";
import type { Transaction } from "../kernel/store.ts";
import { readAttemptPins } from "./record-store.ts";

export function revisionFromRow(tx: Transaction, row: RevisionRow): Revision {
  return revisionSchema.parse({
    node_id: row.node_id,
    filename: row.filename,
    revision: row.revision,
    reason: row.reason,
    actor: JSON.parse(row.actor),
    created_at: row.created_at,
    content: {
      name: row.name,
      requirement: row.requirement,
      criterion: row.criterion,
      verifications: JSON.parse(row.verifications),
      bindings: JSON.parse(row.bindings),
    },
    ...(row.tasks === null ? {} : { tasks: JSON.parse(row.tasks) }),
    change: JSON.parse(row.change),
    pinned_by_attempts: readAttemptPins(tx, row.node_id)
      .filter((pin) => pin.node_revision === row.revision)
      .map((pin) => pin.attempt),
  });
}
