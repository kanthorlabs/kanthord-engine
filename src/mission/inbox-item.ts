import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  externalLinkSchema,
  INBOX_REASONS_BY_RANK,
  type InboxItem,
  type InboxItemDone,
  type InboxItemList,
  type InboxItemQuery,
  InboxItemState,
  type InboxReason,
  type LinkUpdateRow,
  type MissionBindings,
  MissionErrorCode,
  NODE_LIST_LIMIT_DEFAULT,
} from "./contract.ts";
import { cursorOf } from "./link-update-read.ts";
import { encode } from "./node-read.ts";
import { readMission, readMissionByProject } from "./store.ts";

const MS_PER_DAY = 86400000;
const SNOOZE_MAX_DAYS = 30;
export const SNOOZE_MAX_MS = SNOOZE_MAX_DAYS * MS_PER_DAY;
const NOT_FOUND_INDEX = -1;
const NEXT_INDEX = 1;
const CURSOR_SEPARATOR = ":";
const FIRST_INDEX = 0;
const NO_ROWS = 0;

export type InboxThread = Omit<InboxItem, "content">;

type Rows = LinkUpdateRow[];

function notFound(linkUpdateId: string): never {
  throw new OperationError(
    HttpStatus.NotFound,
    MissionErrorCode.InboxItemNotFound,
    "Inbox row not found.",
    { link_update_id: linkUpdateId },
  );
}

function snoozeInvalid(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.InboxItemSnoozeInvalid,
    "snoozed_until must lie in the future and at most 30 days ahead.",
  );
}

function missionNotFound(): never {
  throw new OperationError(
    HttpStatus.NotFound,
    MissionErrorCode.MissionNotFound,
    "Mission not found.",
  );
}

function readInboxRows(
  tx: Transaction,
  missionId: string | null,
  externalLink: string | null,
): Rows {
  return tx.database
    .prepare(
      `SELECT * FROM mission_link_update
       WHERE binding_id IS NOT NULL
         AND (? IS NULL OR mission_id = ?)
         AND (? IS NULL OR external_link = ?)
       ORDER BY mission_id, external_link, occurred_at, id`,
    )
    .all(missionId, missionId, externalLink, externalLink) as unknown as Rows;
}

function threadsOf(rows: Rows): Rows[] {
  const threads = new Map<string, Rows>();
  for (const row of rows) {
    const key = `${row.mission_id}${CURSOR_SEPARATOR}${row.external_link}`;
    const thread = threads.get(key) ?? [];
    thread.push(row);
    threads.set(key, thread);
  }
  return [...threads.values()];
}

function stateOf(newest: LinkUpdateRow, now: number): InboxItemState {
  if (newest.snoozed_until !== null && newest.snoozed_until > now)
    return InboxItemState.Snoozed;
  return newest.done_at === null ? InboxItemState.Open : InboxItemState.Done;
}

function cardReason(
  rows: Rows,
  newest: LinkUpdateRow,
  state: InboxItemState,
): InboxReason {
  if (state === InboxItemState.Done) return newest.reason;
  const doneIndex = rows.findLastIndex((row) => row.done_at !== null);
  const candidates = rows.slice(
    doneIndex === NOT_FOUND_INDEX ? FIRST_INDEX : doneIndex + NEXT_INDEX,
  );
  const reason = INBOX_REASONS_BY_RANK.find((rank) =>
    candidates.some((row) => row.reason === rank),
  );
  assert.ok(reason, "An open thread holds a row after its last done row.");
  return reason;
}

function linkedNodeIds(
  tx: Transaction,
  missionId: string,
  externalLink: string,
): string[] {
  return (
    tx.database
      .prepare(
        `SELECT n.id FROM mission_node n
         JOIN mission_node_revision r ON r.node_id = n.id
           AND r.revision = (
             SELECT MAX(latest.revision) FROM mission_node_revision latest
             WHERE latest.node_id = n.id
           )
         WHERE n.mission_id = ? AND n.retired_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(r.external_links) link WHERE link.value = ?
           )
         ORDER BY n.id`,
      )
      .all(missionId, externalLink) as { id: string }[]
  ).map((row) => row.id);
}

function threadItem(
  tx: Transaction,
  bindings: MissionBindings,
  rows: Rows,
  now: number,
): InboxThread {
  const newest = rows.at(-NEXT_INDEX);
  assert.ok(newest, "A thread holds a row.");
  assert.ok(newest.binding_id !== null, "An inbox row holds a pin.");
  const mission = readMission(tx, newest.mission_id);
  assert.ok(mission, "A row belongs to a mission.");
  const pin = bindings.getBindingRevision(tx, newest.binding_id);
  const state = stateOf(newest, now);
  return {
    link_update_id: newest.id,
    project_id: mission.project_id,
    external_link: externalLinkSchema.parse(JSON.parse(newest.external_link)),
    reason: cardReason(rows, newest, state),
    state,
    occurred_at: newest.occurred_at,
    done_at: newest.done_at,
    snoozed_until: newest.snoozed_until,
    inbound_event_id: newest.inbound_event_id,
    actor_id: newest.actor_id,
    trusted: pin?.link_trust?.actor_ids.includes(newest.actor_id) ?? false,
    linked_node_ids: linkedNodeIds(tx, newest.mission_id, newest.external_link),
  };
}

function compareThreads(left: InboxThread, right: InboxThread): number {
  if (left.occurred_at !== right.occurred_at)
    return left.occurred_at - right.occurred_at;
  return left.link_update_id < right.link_update_id ? -NEXT_INDEX : NEXT_INDEX;
}

function afterCursor(
  thread: InboxThread,
  after: { occurred_at: number; id: string },
): boolean {
  return (
    thread.occurred_at > after.occurred_at ||
    (thread.occurred_at === after.occurred_at &&
      thread.link_update_id > after.id)
  );
}

export function inboxItemPage(
  tx: Transaction,
  bindings: MissionBindings,
  query: InboxItemQuery,
  now: number,
): Omit<InboxItemList, "items"> & { items: InboxThread[] } {
  const missionId =
    query.project_id === undefined
      ? null
      : (readMissionByProject(tx, query.project_id)?.id ?? missionNotFound());
  const threads = threadsOf(readInboxRows(tx, missionId, null))
    .map((rows) => threadItem(tx, bindings, rows, now))
    .sort(compareThreads);
  const counts = {
    open: threads.filter((thread) => thread.state === InboxItemState.Open)
      .length,
    snoozed: threads.filter((thread) => thread.state === InboxItemState.Snoozed)
      .length,
  };
  const after = query.cursor === undefined ? null : cursorOf(query.cursor);
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const state = query.state ?? InboxItemState.Open;
  const selected = threads.filter(
    (thread) =>
      thread.state === state && (after === null || afterCursor(thread, after)),
  );
  const items = selected.slice(FIRST_INDEX, limit);
  const last = items.at(-NEXT_INDEX);
  return {
    items,
    next_cursor:
      selected.length > limit && last !== undefined
        ? encode(`${last.occurred_at}${CURSOR_SEPARATOR}${last.link_update_id}`)
        : null,
    counts,
  };
}

export function markInboxItem(
  tx: Transaction,
  bindings: MissionBindings,
  linkUpdateId: string,
  body: InboxItemDone,
  now: number,
): InboxThread {
  assert.ok(tx.database.isTransaction);
  const row = tx.database
    .prepare("SELECT * FROM mission_link_update WHERE id = ?")
    .get(linkUpdateId) as unknown as LinkUpdateRow | undefined;
  if (row === undefined || row.binding_id === null) notFound(linkUpdateId);
  const snoozedUntil = body.snoozed_until ?? null;
  if (snoozedUntil === null)
    tx.database
      .prepare(
        "UPDATE mission_link_update SET done_at = COALESCE(done_at, ?), snoozed_until = NULL WHERE id = ?",
      )
      .run(now, linkUpdateId);
  else {
    if (snoozedUntil <= now || snoozedUntil > now + SNOOZE_MAX_MS)
      snoozeInvalid();
    tx.database
      .prepare(
        "UPDATE mission_link_update SET snoozed_until = ?, done_at = NULL WHERE id = ?",
      )
      .run(snoozedUntil, linkUpdateId);
  }
  const rows = readInboxRows(tx, row.mission_id, row.external_link);
  assert.ok(rows.length > NO_ROWS);
  return threadItem(tx, bindings, rows, now);
}

export function markThreadDone(
  tx: Transaction,
  missionId: string,
  externalLink: string,
  now: number,
): void {
  assert.ok(tx.database.isTransaction);
  const newest = readInboxRows(tx, missionId, externalLink).at(-NEXT_INDEX);
  if (newest === undefined) return;
  tx.database
    .prepare(
      "UPDATE mission_link_update SET done_at = COALESCE(done_at, ?) WHERE id = ?",
    )
    .run(now, newest.id);
}
