import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import {
  type DecodedLinkUpdate,
  INBOX_REASONS_BY_RANK,
  InboxReason,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";

export interface InboxAdmission {
  reason: InboxReason;
  binding_id: string | null;
  done_at: number | null;
}

interface Pin {
  binding_id: string;
  inbox: { actor_id: string; handle: string };
}

interface InboxAdmissionInput {
  project_id: string;
  mission_id: string;
  external_link: string;
  update: DecodedLinkUpdate;
  actor_id: string;
  linked: boolean;
  now: number;
}

function pinOf(
  tx: Transaction,
  dependencies: Dependencies,
  input: InboxAdmissionInput,
): Pin | null {
  const pinned = tx.database
    .prepare(
      "SELECT binding_id FROM mission_link_update WHERE mission_id = ? AND external_link = ? AND binding_id IS NOT NULL ORDER BY occurred_at, id LIMIT 1",
    )
    .get(input.mission_id, input.external_link) as
    { binding_id: string } | undefined;
  if (pinned === undefined)
    return dependencies.bindings.conversationInboxOf(
      tx,
      input.project_id,
      input.update.external_link.resource_identity,
    );
  const revision = dependencies.bindings.getBindingRevision(
    tx,
    pinned.binding_id,
  );
  assert.ok(revision?.inbox, "A pinned binding revision holds an inbox.");
  return { binding_id: pinned.binding_id, inbox: revision.inbox };
}

function threadHoldsRow(tx: Transaction, input: InboxAdmissionInput): boolean {
  return (
    tx.database
      .prepare(
        "SELECT 1 FROM mission_link_update WHERE mission_id = ? AND external_link = ? LIMIT 1",
      )
      .get(input.mission_id, input.external_link) !== undefined
  );
}

function mentions(update: DecodedLinkUpdate, inbox: Pin["inbox"]): boolean {
  return (
    update.mentions.includes(inbox.handle.toLowerCase()) ||
    update.mentions.includes(inbox.actor_id)
  );
}

export function admitInboxReason(
  tx: Transaction,
  dependencies: Dependencies,
  input: InboxAdmissionInput,
): InboxAdmission | null {
  const pin = pinOf(tx, dependencies, input);
  if (pin === null)
    return input.linked
      ? { reason: InboxReason.Linked, binding_id: null, done_at: null }
      : null;
  if (input.actor_id === pin.inbox.actor_id)
    return {
      reason: InboxReason.Participating,
      binding_id: pin.binding_id,
      done_at: input.now,
    };
  const held = new Set<InboxReason>();
  if (input.linked) held.add(InboxReason.Linked);
  if (mentions(input.update, pin.inbox)) held.add(InboxReason.Mentioned);
  if (threadHoldsRow(tx, input)) held.add(InboxReason.Participating);
  const reason = INBOX_REASONS_BY_RANK.find((rank) => held.has(rank));
  if (reason === undefined) return null;
  return { reason, binding_id: pin.binding_id, done_at: null };
}
