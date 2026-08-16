import type { LeaseOwnerKind } from "./lease.ts";
import type { NodeKind } from "./state.ts";

export const leaseRelations = [
  "self",
  "ancestor",
  "descendant",
  "sibling",
] as const;
export type LeaseRelation = (typeof leaseRelations)[number];

export type LiveLease = Readonly<{
  subjectId: string;
  owner: string;
  ownerKind: LeaseOwnerKind;
  fence: number;
  expiresAt: number;
}>;

export type LeaseHierarchyInput = Readonly<{
  targetId: string;
  targetKind: NodeKind;
  parentId: string | null;
  childIds: readonly string[];
  siblingIds: readonly string[];
  owner: string;
  liveLeases: readonly LiveLease[];
}>;

export type LeaseRefusal = Readonly<{
  subjectId: string;
  holder: string;
  holderKind: LeaseOwnerKind;
  fence: number;
  relation: LeaseRelation;
  expiresAt: number;
}>;

function relationOf(
  lease: LiveLease,
  input: LeaseHierarchyInput,
): LeaseRelation | null {
  if (lease.subjectId === input.targetId) return "self";
  if (input.parentId !== null && lease.subjectId === input.parentId) {
    return "ancestor";
  }
  if (input.childIds.includes(lease.subjectId)) return "descendant";
  if (input.siblingIds.includes(lease.subjectId)) return "sibling";
  return null;
}

function refusesAt(targetKind: NodeKind, relation: LeaseRelation): boolean {
  if (targetKind === "task") return relation !== "descendant";
  if (targetKind === "objective") {
    return relation === "self" || relation === "descendant";
  }
  return false;
}

export function liveLeaseRefusal(
  input: LeaseHierarchyInput,
): LeaseRefusal | null {
  if (input.targetKind === "initiative") return null;
  const refusing: Array<{ lease: LiveLease; relation: LeaseRelation }> = [];
  for (const lease of input.liveLeases) {
    if (lease.owner === input.owner) continue;
    const relation = relationOf(lease, input);
    if (relation === null) continue;
    if (!refusesAt(input.targetKind, relation)) continue;
    refusing.push({ lease, relation });
  }
  for (const relation of leaseRelations) {
    const candidates = refusing.filter((entry) => entry.relation === relation);
    if (candidates.length === 0) continue;
    const chosen = candidates.reduce((smallest, candidate) =>
      Buffer.compare(
        Buffer.from(candidate.lease.subjectId, "utf8"),
        Buffer.from(smallest.lease.subjectId, "utf8"),
      ) < 0
        ? candidate
        : smallest,
    );
    return {
      subjectId: chosen.lease.subjectId,
      holder: chosen.lease.owner,
      holderKind: chosen.lease.ownerKind,
      fence: chosen.lease.fence,
      relation: chosen.relation,
      expiresAt: chosen.lease.expiresAt,
    };
  }
  return null;
}
