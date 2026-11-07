import assert from "node:assert/strict";
import { identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { readMissionByProject } from "./store.ts";
import {
  type AdmissionAnswer,
  AdmissionRefusal,
  AssetKind,
  type DecodedLinkUpdate,
  Disposition,
  externalLinkSchema,
  NodeState,
  type PlatformAddress,
  PlatformAddressKind,
  platformAddressSchema,
} from "./contract.ts";

const MS_PER_DAY = 86400000;
const TERMINAL_LINK_DEMAND_DAYS = 14;
export const TERMINAL_LINK_DEMAND_MS = TERMINAL_LINK_DEMAND_DAYS * MS_PER_DAY;
const SINGLE_MATCH = 1;
const NO_MATCH = 0;
const projectIdSchema = identitySchema("project");

export const MatchKind = {
  Request: "request",
  Answer: "answer",
  Link: "link",
} as const;

export type RequestMatch =
  | { kind: typeof MatchKind.Request; evidence_id: string }
  | { kind: typeof MatchKind.Answer; answer: AdmissionAnswer };

export type LinkUpdateMatch =
  | { kind: typeof MatchKind.Link; mission_id: string; external_link: string }
  | { kind: typeof MatchKind.Answer; answer: AdmissionAnswer };

interface MatchRow {
  id: string;
  end_state: string | null;
  closed_at: number | null;
}

function readRequestMatches(
  tx: Transaction,
  projectId: string,
  address: PlatformAddress,
): { unresolved: string[]; resolved: string[] } {
  assert.ok(projectIdSchema.safeParse(projectId).success);
  const content = canonicalJSON(platformAddressSchema.parse(address));
  const rows = tx.database
    .prepare(
      "SELECT e.id, e.end_state, t.closed_at FROM mission_evidence e JOIN mission_node n ON n.id = e.node_id JOIN mission_mission m ON m.id = n.mission_id JOIN mission_attempt t ON t.node_id = e.node_id AND t.attempt = e.attempt JOIN mission_evidence_asset a ON a.evidence_id = e.id WHERE m.project_id = ? AND e.requirement_key IS NOT NULL AND a.kind = ? AND a.content = ? ORDER BY e.id",
    )
    .all(projectId, AssetKind.Platform, content) as unknown as MatchRow[];
  const unresolved = rows
    .filter((row) => row.end_state === null && row.closed_at === null)
    .map((row) => row.id);
  const resolved = rows
    .filter((row) => row.end_state !== null)
    .map((row) => row.id);
  assert.ok(unresolved.length + resolved.length <= rows.length);
  return { unresolved, resolved };
}

export function matchRequests(
  tx: Transaction,
  projectId: string,
  address: PlatformAddress,
): RequestMatch {
  const { unresolved, resolved } = readRequestMatches(tx, projectId, address);
  if (unresolved.length > SINGLE_MATCH)
    return refused(AdmissionRefusal.Ambiguous);
  if (unresolved.length === SINGLE_MATCH)
    return { kind: MatchKind.Request, evidence_id: unresolved[0]! };
  if (resolved.length > NO_MATCH)
    return {
      kind: MatchKind.Answer,
      answer: { disposition: Disposition.Duplicate, reason: null },
    };
  return refused(AdmissionRefusal.Unmatched);
}

export function matchLinkUpdate(
  tx: Transaction,
  projectId: string,
  update: DecodedLinkUpdate,
): LinkUpdateMatch {
  assert.ok(projectIdSchema.safeParse(projectId).success);
  const mission = readMissionByProject(tx, projectId);
  if (mission === null) return refused(AdmissionRefusal.Unmatched);
  const externalLink = canonicalJSON(
    externalLinkSchema.parse(update.external_link),
  );
  const recorded = tx.database
    .prepare(
      "SELECT 1 FROM mission_link_update WHERE mission_id = ? AND external_link = ? AND update_key = ?",
    )
    .get(mission.id, externalLink, update.update_key);
  if (recorded !== undefined)
    return {
      kind: MatchKind.Answer,
      answer: { disposition: Disposition.Duplicate, reason: null },
    };
  const linked = tx.database
    .prepare(
      `SELECT 1 FROM mission_node n
       JOIN mission_node_revision r ON r.node_id = n.id
         AND r.revision = (
           SELECT MAX(latest.revision) FROM mission_node_revision latest
           WHERE latest.node_id = n.id
         )
       WHERE n.mission_id = ? AND n.retired_at IS NULL
         AND EXISTS (
           SELECT 1 FROM json_each(r.external_links) link WHERE link.value = ?
         )`,
    )
    .get(mission.id, externalLink);
  if (linked === undefined) return refused(AdmissionRefusal.Unmatched);
  return {
    kind: MatchKind.Link,
    mission_id: mission.id,
    external_link: externalLink,
  };
}

function unresolvedRequestAddresses(
  tx: Transaction,
  projectId: string,
): { id: string; address: PlatformAddress }[] {
  assert.ok(projectIdSchema.safeParse(projectId).success);
  const rows = tx.database
    .prepare(
      "SELECT e.id, a.content FROM mission_evidence e JOIN mission_node n ON n.id = e.node_id JOIN mission_mission m ON m.id = n.mission_id JOIN mission_attempt t ON t.node_id = e.node_id AND t.attempt = e.attempt JOIN mission_evidence_asset a ON a.evidence_id = e.id WHERE m.project_id = ? AND e.requirement_key IS NOT NULL AND e.end_state IS NULL AND t.closed_at IS NULL AND a.kind = ? ORDER BY e.id",
    )
    .all(projectId, AssetKind.Platform) as unknown as {
    id: string;
    content: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    address: platformAddressSchema.parse(JSON.parse(row.content)),
  }));
}

export function unresolvedBaseRequests(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
): string[] {
  assert.ok(resourceIdentity.length);
  return unresolvedRequestAddresses(tx, projectId)
    .filter(
      ({ address }) =>
        (address.kind === PlatformAddressKind.PullRequest ||
          address.kind === PlatformAddressKind.BranchPush) &&
        address.resource_identity === resourceIdentity,
    )
    .map(({ id }) => id);
}

export function unresolvedRequestCount(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
): number {
  assert.ok(resourceIdentity.length);
  return unresolvedRequestAddresses(tx, projectId).filter(
    ({ address }) => address.resource_identity === resourceIdentity,
  ).length;
}

export function linkDemandCount(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
  now: number,
): number {
  assert.ok(projectIdSchema.safeParse(projectId).success);
  assert.ok(resourceIdentity.length);
  const row = tx.database
    .prepare(
      `SELECT COUNT(*) AS link_count FROM mission_mission m
       JOIN mission_node n ON n.mission_id = m.id AND n.retired_at IS NULL
       JOIN mission_node_revision r ON r.node_id = n.id
         AND r.revision = (
           SELECT MAX(latest.revision) FROM mission_node_revision latest
           WHERE latest.node_id = n.id
         )
       JOIN json_each(r.external_links) link
       WHERE m.project_id = ?
         AND json_extract(link.value, '$.resource_identity') = ?
         AND (n.state NOT IN (?, ?) OR EXISTS (
           SELECT 1 FROM mission_attempt a
           WHERE a.node_id = n.id AND a.attempt = n.attempt
             AND a.closed_at IS NOT NULL AND ? - a.closed_at < ?
         ))`,
    )
    .get(
      projectId,
      resourceIdentity,
      NodeState.Completed,
      NodeState.Discarded,
      now,
      TERMINAL_LINK_DEMAND_MS,
    ) as { link_count: number };
  return row.link_count;
}

function refused(reason: AdmissionRefusal): {
  kind: typeof MatchKind.Answer;
  answer: AdmissionAnswer;
} {
  assert.ok(Object.values(AdmissionRefusal).includes(reason));
  return {
    kind: MatchKind.Answer,
    answer: { disposition: Disposition.Refused, reason },
  };
}
