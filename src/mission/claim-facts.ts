import assert from "node:assert/strict";
import { z } from "zod";
import type { Transaction } from "../kernel/store.ts";
import { isTerminal } from "./admission.ts";
import {
  ClaimableState,
  MissionBindingKind,
  tagsSchema,
  intentSchema,
  AssessmentResult,
  NodeState,
  type ClaimFacts,
  type ClaimFactsRow,
  type FrozenAction,
  type MissionBindings,
} from "./contract.ts";
import { actionsOfRevision } from "./frozen-action.ts";
import { readAssessmentsOfAttempt } from "./record-store.ts";
import {
  claimRevisionOf,
  countDependencies,
  readClaimRevisions,
  readMissionByProject,
  readNode,
  type NodeRow,
  type RevisionRow,
} from "./store.ts";

const NO_ACTIONS = 0;
const RESOURCE_KIND_SEPARATOR = ":";
const bindingIdsSchema = z.array(z.string());

function claimable(node: NodeRow | null): node is NodeRow {
  return node !== null && node.retired_at === null && !isTerminal(node.state);
}

function repositoriesOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: RevisionRow,
): string[] {
  return bindingIdsSchema
    .parse(JSON.parse(revision.bindings))
    .flatMap((bindingId) => {
      const binding = bindings.getBindingRevision(tx, bindingId);
      assert.ok(binding);
      return binding.resource_identity.split(RESOURCE_KIND_SEPARATOR)[0] ===
        MissionBindingKind.Repository
        ? [binding.resource_identity]
        : [];
    });
}

function factsOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: RevisionRow,
): ClaimFacts {
  return {
    intent: intentSchema.parse(revision.intent),
    tags: tagsSchema.parse(JSON.parse(revision.tags)),
    repositories: repositoriesOf(tx, bindings, revision),
  };
}

function rowOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: RevisionRow,
  actions: Map<string, FrozenAction | null>,
): ClaimFactsRow {
  const claims: ClaimableState[] = [
    ClaimableState.Available,
    ClaimableState.Waiting,
  ];
  if (actionsOfRevision(tx, bindings, revision, actions).length > NO_ACTIONS)
    claims.push(ClaimableState.ExternalRequested);
  return {
    node_id: revision.node_id,
    revision: revision.revision,
    ...factsOf(tx, bindings, revision),
    claims,
  };
}

export function claimFacts(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
): ClaimFacts | null {
  assert.ok(tx.database.isTransaction);
  if (!claimable(readNode(tx, nodeId))) return null;
  return factsOf(tx, bindings, claimRevisionOf(tx, nodeId));
}

export function openingFacts(
  tx: Transaction,
  nodeId: string,
): {
  dependency_count: number;
  revision_turn: boolean;
  node_name: string;
} | null {
  assert.ok(tx.database.isTransaction);
  const node = readNode(tx, nodeId);
  if (node === null) return null;
  const last = readAssessmentsOfAttempt(tx, nodeId, node.attempt).at(-1);
  return {
    dependency_count: countDependencies(tx, nodeId),
    revision_turn:
      node.state === NodeState.Available &&
      last?.result === AssessmentResult.CriterionNotMet,
    node_name: claimRevisionOf(tx, nodeId).name,
  };
}

export function claimFactsOf(
  tx: Transaction,
  bindings: MissionBindings,
  projectId: string,
): ClaimFactsRow[] {
  assert.ok(tx.database.isTransaction);
  const mission = readMissionByProject(tx, projectId);
  if (!mission) return [];
  const actions = new Map<string, FrozenAction | null>();
  const revisions = new Map<
    string,
    ReturnType<MissionBindings["getBindingRevision"]>
  >();
  const cached: MissionBindings = {
    ...bindings,
    getBindingRevision: (bindingTx, bindingId) => {
      if (!revisions.has(bindingId))
        revisions.set(
          bindingId,
          bindings.getBindingRevision(bindingTx, bindingId),
        );
      return revisions.get(bindingId) ?? null;
    },
  };
  return readClaimRevisions(tx, mission.id).map((revision) =>
    rowOf(tx, cached, revision, actions),
  );
}
