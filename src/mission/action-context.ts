import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  type ActionContext,
  AssetKind,
  type MissionBindings,
  PlatformAddressKind,
  platformAddressSchema,
  type RepositoryPlatformAddress,
  testedInputSchema,
} from "./contract.ts";
import { currentAssessmentOf } from "./currency.ts";
import { actionStatesOf, eligibleUnrequested } from "./frozen-action.ts";
import { gateFilesOf } from "./gate-files.ts";
import { readAssets, readAttempt, readRequests } from "./record-store.ts";
import { readNode, readRevision } from "./store.ts";

type Candidate = ActionContext["actions"][number]["reuse_candidates"][number];
const MINIMUM_ATTEMPT = 0;
const EMPTY_KEY_LENGTH = 0;
const FIRST_ATTEMPT = 1;

function candidatesOf(
  tx: Transaction,
  nodeId: string,
  attempt: number,
  key: string,
): Candidate[] {
  assert.ok(Number.isSafeInteger(attempt) && attempt > MINIMUM_ATTEMPT);
  assert.ok(key.length > EMPTY_KEY_LENGTH);
  const candidates = new Map<string, Candidate>();
  for (let earlier = attempt - 1; earlier >= FIRST_ATTEMPT; earlier--) {
    const requests = readRequests(tx, nodeId, earlier).filter(
      (row) => row.requirement_key === key,
    );
    const next = requests.flatMap((request) =>
      readAssets(tx, request.id)
        .filter((asset) => asset.kind === AssetKind.Platform)
        .flatMap((asset) => {
          const address = platformAddressSchema.parse(
            JSON.parse(asset.content),
          );
          return address.kind === PlatformAddressKind.PullRequest
            ? [{ evidence_id: request.id, attempt: earlier, address }]
            : [];
        }),
    );
    for (const candidate of next) {
      const address = canonicalJSON(candidate.address);
      if (!candidates.has(address)) candidates.set(address, candidate);
    }
  }
  return [...candidates.values()];
}

function requestAddressesOf(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): RepositoryPlatformAddress[] {
  return readRequests(tx, nodeId, attempt).flatMap((request) =>
    readAssets(tx, request.id)
      .filter((asset) => asset.kind === AssetKind.Platform)
      .flatMap((asset) => {
        const address = platformAddressSchema.parse(JSON.parse(asset.content));
        return address.kind === PlatformAddressKind.Comment ? [] : [address];
      }),
  );
}

export function actionContextOf(
  tx: Transaction,
  dependencies: { bindings: MissionBindings },
  nodeId: string,
  attempt: number,
): ActionContext {
  const node = readNode(tx, nodeId);
  assert.ok(node && node.state !== null);
  assert.ok(Number.isSafeInteger(attempt) && attempt > MINIMUM_ATTEMPT);
  const assessment = currentAssessmentOf(tx, nodeId, attempt);
  assert.ok(assessment === null || assessment.tested_input !== null);
  const pinned = readAttempt(tx, nodeId, attempt);
  assert.ok(pinned);
  const revision = readRevision(tx, nodeId, pinned.node_revision);
  assert.ok(revision);
  const states = actionStatesOf(tx, dependencies.bindings, nodeId, attempt);
  const eligible = new Set(
    eligibleUnrequested(states).map(({ action }) => action.key),
  );
  return {
    state: node.state,
    node_name: revision.name,
    request_addresses: requestAddressesOf(tx, nodeId, attempt),
    current_assessment:
      assessment === null
        ? null
        : {
            result: assessment.result,
            tested_input: testedInputSchema.parse(
              JSON.parse(assessment.tested_input!),
            ),
          },
    actions: states.map(({ action, resolution, request }) => {
      const binding = dependencies.bindings.getBindingRevision(
        tx,
        action.binding_id,
      );
      assert.ok(binding);
      assert.equal(binding.binding_id, action.binding_id);
      return {
        action,
        resource_identity: binding.resource_identity,
        resolution,
        request_evidence_id: request?.id ?? null,
        eligible: eligible.has(action.key),
        gate_files: gateFilesOf(assessment, action.binding_id),
        reuse_candidates: candidatesOf(tx, nodeId, attempt, action.key),
      };
    }),
  };
}
