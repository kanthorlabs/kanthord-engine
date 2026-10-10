import assert from "node:assert/strict";
import { identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AdmissionRefusal,
  AssetKind,
  Disposition,
  PlatformAddressKind,
  platformAddressSchema,
  type AdmissionAnswer,
  type PlatformAddress,
} from "./contract.ts";

const SINGLE_MATCH = 1;
const NO_MATCH = 0;
const projectIdSchema = identitySchema("project");

export const MatchKind = {
  Request: "request",
  Answer: "answer",
} as const;

export type RequestMatch =
  | { kind: typeof MatchKind.Request; evidence_id: string }
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

export function unresolvedPullRequests(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
): string[] {
  assert.ok(projectIdSchema.safeParse(projectId).success);
  assert.ok(resourceIdentity.length);
  const rows = tx.database
    .prepare(
      "SELECT e.id, a.content FROM mission_evidence e JOIN mission_node n ON n.id = e.node_id JOIN mission_mission m ON m.id = n.mission_id JOIN mission_attempt t ON t.node_id = e.node_id AND t.attempt = e.attempt JOIN mission_evidence_asset a ON a.evidence_id = e.id WHERE m.project_id = ? AND e.requirement_key IS NOT NULL AND e.end_state IS NULL AND t.closed_at IS NULL AND a.kind = ? ORDER BY e.id",
    )
    .all(projectId, AssetKind.Platform) as unknown as {
    id: string;
    content: string;
  }[];
  return rows
    .filter((row) => {
      const address = platformAddressSchema.parse(JSON.parse(row.content));
      return (
        address.kind === PlatformAddressKind.PullRequest &&
        address.resource_identity === resourceIdentity
      );
    })
    .map((row) => row.id);
}

function refused(reason: AdmissionRefusal): RequestMatch {
  assert.ok(Object.values(AdmissionRefusal).includes(reason));
  return {
    kind: MatchKind.Answer,
    answer: { disposition: Disposition.Refused, reason },
  };
}
