import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  githubCheckpointSchema,
  newerEvents,
  type GitHubCheckpoint,
  type GitHubEvent,
} from "../repository/github.ts";
import { findEvent, insertEvent, pendingCount } from "./event-store.ts";
import { readInbound } from "./inbound-store.ts";

const NO_LENGTH = 0;
const NO_ROOM = 0;
const ONE_ROW = 1;
const EMPTY_CHECKPOINT: GitHubCheckpoint = {
  etag: null,
  newest_event_id: null,
};

function checkpointOf(text: string | null): GitHubCheckpoint {
  if (text === null) return EMPTY_CHECKPOINT;
  return githubCheckpointSchema.parse(JSON.parse(text));
}

function writeCheckpoint(
  tx: Transaction,
  inboundId: string,
  checkpoint: GitHubCheckpoint,
): void {
  assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
  const changes = tx.database
    .prepare("UPDATE intake_inbound SET checkpoint = ? WHERE id = ?")
    .run(
      canonicalJSON(githubCheckpointSchema.parse(checkpoint)),
      inboundId,
    ).changes;
  assert.equal(Number(changes), ONE_ROW, "A checkpoint writes one row.");
}

export function storeBatch(
  tx: Transaction,
  pendingEventLimit: number,
  inboundId: string,
  answer: { etag: string | null; events: GitHubEvent[] },
): boolean {
  assert.ok(Number.isSafeInteger(pendingEventLimit));
  assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
  const row = readInbound(tx, inboundId);
  if (row === null) return false;
  const previous = checkpointOf(row.checkpoint);
  let room = pendingEventLimit - pendingCount(tx);
  let newest = previous.newest_event_id;
  let unstored = false;
  for (const event of newerEvents(answer.events, previous.newest_event_id)) {
    if (findEvent(tx, inboundId, event.id) !== null) continue;
    if (room <= NO_ROOM) {
      unstored = true;
      break;
    }
    insertEvent(tx, {
      inbound_id: inboundId,
      event_id: event.id,
      event: event.body,
      metadata: { event: event.type },
      created_at: Date.now(),
    });
    newest = event.id;
    room -= ONE_ROW;
  }
  writeCheckpoint(tx, inboundId, {
    etag: unstored ? null : answer.etag,
    newest_event_id: newest,
  });
  return true;
}
