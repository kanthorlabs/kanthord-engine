import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTION_REQUEST_TOOL_NAME,
  ActionResultKind,
  PlatformAddressKind,
  RefusalClass,
  ResultClass,
  Uncertainty,
  actionRequestResultSchema,
  actionResultItemSchema,
  platformAddressSchema,
} from "./contract.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const action = { key: "gated.pull_request", bindingId: `binding_${ID}` };
const refusal = {
  class: RefusalClass.FinalRefusal,
  code: "repository.platform.github.final_refusal",
  message: "Bad credentials",
};

test("action result accepts all four classes and retains Mission evidence", () => {
  const evidence = { id: `evidence_${ID}`, assets: [], attempt: 1 };
  const items = [
    { kind: ActionResultKind.Submitted, evidence },
    {
      kind: ActionResultKind.AwaitingPrerequisite,
      action,
      prerequisite: { key: "earlier", evidenceId: `evidence_${ID}` },
    },
    { kind: ActionResultKind.FailedBeforeEffect, action, refusal },
    {
      kind: ActionResultKind.Uncertain,
      action,
      uncertainty: Uncertainty.Effect,
    },
  ];
  assert.deepEqual(
    actionRequestResultSchema.parse({
      toolName: ACTION_REQUEST_TOOL_NAME,
      items,
    }).items,
    items,
  );
  assert.equal(
    actionRequestResultSchema.safeParse({ toolName: "other", items }).success,
    false,
  );
});

test("unknown outcome cannot claim no effect and unknown item kinds fail", () => {
  assert.equal(
    actionResultItemSchema.safeParse({
      kind: ActionResultKind.FailedBeforeEffect,
      action,
      refusal: { ...refusal, class: ResultClass.UnknownOutcome },
    }).success,
    false,
  );
  assert.equal(
    actionResultItemSchema.safeParse({ kind: "other", action }).success,
    false,
  );
});

test("platform addresses require their complete kind-specific operands", () => {
  const resourceIdentity = "repository:github:owner/gated";
  const push = {
    kind: PlatformAddressKind.BranchPush,
    resourceIdentity,
    branch: "main",
  };
  assert.equal(platformAddressSchema.safeParse(push).success, false);
  assert.deepEqual(
    platformAddressSchema.parse({ ...push, commit: "b".repeat(40) }),
    { ...push, commit: "b".repeat(40) },
  );
  assert.equal(
    platformAddressSchema.safeParse({
      kind: PlatformAddressKind.PullRequest,
      resourceIdentity,
      number: 42,
    }).success,
    true,
  );
  assert.equal(
    platformAddressSchema.safeParse({
      kind: PlatformAddressKind.PullRequest,
      resourceIdentity,
      number: Number.MAX_SAFE_INTEGER + 1,
    }).success,
    false,
  );
});
