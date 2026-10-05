import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  PlatformAddressKind,
  platformAddressSchema,
  testedInputSchema,
  type ActionContext,
  type MissionBindings,
} from "./contract.ts";
import { currentAssessmentOf } from "./currency.ts";
import { actionStatesOf, eligibleUnrequested } from "./frozen-action.ts";
import { readRequests, readAssets } from "./record-store.ts";
import { readNode } from "./store.ts";

type Candidate = ActionContext["actions"][number]["reuseCandidates"][number];
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
        .map((asset) => ({
          evidenceId: request.id,
          attempt: earlier,
          address: platformAddressSchema.parse(JSON.parse(asset.content)),
        })),
    );
    for (const candidate of next) {
      if (candidate.address.kind !== PlatformAddressKind.PullRequest) continue;
      const address = canonicalJSON(candidate.address);
      if (!candidates.has(address)) candidates.set(address, candidate);
    }
  }
  return [...candidates.values()];
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
  const states = actionStatesOf(tx, dependencies.bindings, nodeId, attempt);
  const eligible = new Set(
    eligibleUnrequested(states).map(({ action }) => action.key),
  );
  return {
    state: node.state,
    currentAssessment:
      assessment === null
        ? null
        : {
            result: assessment.result,
            testedInput: testedInputSchema.parse(
              JSON.parse(assessment.tested_input!),
            ),
          },
    actions: states.map(({ action, resolution, request }) => {
      const binding = dependencies.bindings.getBindingRevision(
        tx,
        action.bindingId,
      );
      assert.ok(binding);
      assert.equal(binding.bindingId, action.bindingId);
      return {
        action,
        resourceIdentity: binding.resourceIdentity,
        resolution,
        requestEvidenceId: request?.id ?? null,
        eligible: eligible.has(action.key),
        reuseCandidates: candidatesOf(tx, nodeId, attempt, action.key),
      };
    }),
  };
}
