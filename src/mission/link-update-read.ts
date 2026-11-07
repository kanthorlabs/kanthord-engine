import assert from "node:assert/strict";
import { z } from "zod";
import { identitySchema, identityTime } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  externalLinksSchema,
  LINK_UPDATE_IDENTITY_PREFIX,
  type LinkUpdate,
  type LinkUpdatePage,
  type LinkUpdateRow,
  linkUpdateSchema,
  type MissionBindings,
  NODE_LIST_LIMIT_DEFAULT,
} from "./contract.ts";
import { decode, encode, invalidCursor, requireNode } from "./node-read.ts";
import { readAttempt } from "./record-store.ts";
import {
  readCurrentRevision,
  readRevision,
  type RevisionRow,
} from "./store.ts";

const FIRST_INDEX = 0;
const FIRST_ATTEMPT = 1;
const bindingIdsSchema = z.array(z.string());
const NO_ATTEMPT = 0;
const PAGINATION_LOOKAHEAD = 1;
const LAST_ITEM_OFFSET = 1;
const CURSOR_SEPARATOR = ":";
const NO_ACTORS = 0;
const NO_ROWS = 0;
const NO_TRUSTED_LINKS = 0;
const SEPARATOR_LENGTH = 1;

interface TrustedLink {
  external_link: string;
  actor_ids: string[];
}

export interface LinkUpdateRows {
  items: LinkUpdate[];
  next_cursor: string | null;
  total: number;
}

function trustedLinksOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: RevisionRow,
): TrustedLink[] {
  const actorsByResource = new Map<string, string[]>();
  for (const bindingId of bindingIdsSchema.parse(
    JSON.parse(revision.bindings),
  )) {
    const pinned = bindings.getBindingRevision(tx, bindingId);
    if (pinned === null || actorsByResource.has(pinned.resource_identity))
      continue;
    actorsByResource.set(
      pinned.resource_identity,
      pinned.link_trust?.actor_ids ?? [],
    );
  }
  return externalLinksSchema
    .parse(JSON.parse(revision.external_links))
    .map((link) => ({
      external_link: canonicalJSON(link),
      actor_ids: actorsByResource.get(link.resource_identity) ?? [],
    }))
    .filter((trusted) => trusted.actor_ids.length > NO_ACTORS);
}

function cursorOf(cursor: string): { occurred_at: number; id: string } {
  const value = decode(cursor);
  const separator = value.indexOf(CURSOR_SEPARATOR);
  const occurredAt = Number(value.slice(FIRST_INDEX, separator));
  const id = value.slice(separator + SEPARATOR_LENGTH);
  if (
    separator < FIRST_INDEX ||
    !Number.isSafeInteger(occurredAt) ||
    !identitySchema(LINK_UPDATE_IDENTITY_PREFIX).safeParse(id).success
  )
    invalidCursor();
  return { occurred_at: occurredAt, id };
}

function itemOf(row: LinkUpdateRow, newSince: number | null): LinkUpdate {
  return linkUpdateSchema.parse({
    id: row.id,
    external_link: JSON.parse(row.external_link),
    update_key: row.update_key,
    inbound_event_id: row.inbound_event_id,
    actor_id: row.actor_id,
    occurred_at: row.occurred_at,
    new: newSince === null || identityTime(row.id) >= newSince,
  });
}

function readLinkUpdates(
  tx: Transaction,
  bindings: MissionBindings,
  missionId: string,
  revision: RevisionRow,
  newSince: number | null,
  page: LinkUpdatePage,
): LinkUpdateRows {
  const trusted = trustedLinksOf(tx, bindings, revision);
  if (trusted.length === NO_TRUSTED_LINKS)
    return { items: [], next_cursor: null, total: NO_ROWS };
  const trust = trusted
    .map(
      () =>
        "(external_link = ? AND actor_id IN (SELECT value FROM json_each(?)))",
    )
    .join(" OR ");
  const trustValues = trusted.flatMap((link) => [
    link.external_link,
    JSON.stringify(link.actor_ids),
  ]);
  const where = `mission_id = ? AND (${trust})`;
  const total = tx.database
    .prepare(`SELECT COUNT(*) AS total FROM mission_link_update WHERE ${where}`)
    .get(missionId, ...trustValues) as { total: number };
  const after = page.cursor === undefined ? null : cursorOf(page.cursor);
  const limit = page.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const rows = tx.database
    .prepare(
      `SELECT * FROM mission_link_update WHERE ${where}
       AND (? IS NULL OR occurred_at < ? OR (occurred_at = ? AND id < ?))
       ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .all(
      missionId,
      ...trustValues,
      after?.occurred_at ?? null,
      after?.occurred_at ?? null,
      after?.occurred_at ?? null,
      after?.id ?? null,
      limit + PAGINATION_LOOKAHEAD,
    ) as unknown as LinkUpdateRow[];
  const items = rows
    .slice(FIRST_INDEX, limit)
    .map((row) => itemOf(row, newSince));
  const last = rows[limit - LAST_ITEM_OFFSET];
  return {
    items,
    next_cursor:
      rows.length > limit && last !== undefined
        ? encode(`${last.occurred_at}${CURSOR_SEPARATOR}${last.id}`)
        : null,
    total: total.total,
  };
}

function openedAt(tx: Transaction, nodeId: string, attempt: number): number {
  const row = readAttempt(tx, nodeId, attempt);
  assert.ok(row, "A counted attempt exists.");
  return row.opened_at;
}

export function linkUpdatesOf(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  attempt: number,
  page: LinkUpdatePage,
): LinkUpdateRows {
  assert.ok(Number.isSafeInteger(attempt) && attempt >= FIRST_ATTEMPT);
  const node = requireNode(tx, nodeId);
  const claimed = readAttempt(tx, nodeId, attempt);
  assert.ok(claimed, "A read attempt exists.");
  const revision = readRevision(tx, nodeId, claimed.node_revision);
  assert.ok(revision, "An attempt pins an existing revision.");
  const newSince =
    attempt === FIRST_ATTEMPT ? null : openedAt(tx, nodeId, attempt - 1);
  return readLinkUpdates(
    tx,
    bindings,
    node.mission_id,
    revision,
    newSince,
    page,
  );
}

export function linkUpdatePage(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  page: LinkUpdatePage,
): Omit<LinkUpdateRows, "total"> {
  const node = requireNode(tx, nodeId);
  const revision = readCurrentRevision(tx, nodeId);
  assert.ok(revision, "A node has a revision.");
  const newSince =
    node.attempt === NO_ATTEMPT ? null : openedAt(tx, nodeId, node.attempt);
  const { items, next_cursor } = readLinkUpdates(
    tx,
    bindings,
    node.mission_id,
    revision,
    newSince,
    page,
  );
  return { items, next_cursor };
}
