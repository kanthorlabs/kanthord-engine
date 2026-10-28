import assert from "node:assert/strict";
import { test } from "node:test";
import { StablePlacementIssue, WorkerPlacement } from "../project/contract.ts";
import { EnvironmentSource } from "../kernel/devcontainer.ts";
import {
  ACTION_REQUEST_TOOL_NAME,
  actionRequestResultSchema,
  actionResultItemSchema,
  ActionResultKind,
  alwaysAvailable,
  ContainerRuntime,
  executionEnvironmentSchema,
  InstancePlacement,
  PlacementIssue,
  placementStatusSchema,
  PlatformAddressKind,
  platformAddressSchema,
  POOL_PLACEMENTS,
  RefusalClass,
  ResultClass,
  Uncertainty,
} from "./contract.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

type Same<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

test("the instance placement and the binding placement hold the same values", () => {
  const same: Same<InstancePlacement, WorkerPlacement> = true;
  assert.ok(same);
  assert.deepEqual(Object.values(InstancePlacement), [
    "server",
    "container",
    "worker",
  ]);
  assert.deepEqual(
    Object.values(WorkerPlacement),
    Object.values(InstancePlacement),
  );
  assert.deepEqual(POOL_PLACEMENTS, ["server", "container"]);
});
test("the stable placement reasons of the binding write are placement issues", () => {
  const issues: readonly string[] = Object.values(PlacementIssue);
  for (const reason of Object.values(StablePlacementIssue))
    assert.ok(issues.includes(reason));
  assert.ok(
    !(Object.values(StablePlacementIssue) as string[]).includes(
      PlacementIssue.RuntimeFailed,
    ),
  );
});

test("the placement status schema accepts an available and an unavailable answer", () => {
  assert.deepEqual(
    placementStatusSchema.parse(alwaysAvailable(InstancePlacement.Worker)),
    alwaysAvailable(InstancePlacement.Worker),
  );
  const unavailable = {
    placement: InstancePlacement.Container,
    available: false,
    reason: PlacementIssue.RuntimeRootful,
    detail: null,
    container_runtime: ContainerRuntime.Docker,
  };
  assert.deepEqual(placementStatusSchema.parse(unavailable), unavailable);
  assert.throws(() =>
    placementStatusSchema.parse({ ...unavailable, reason: "other" }),
  );
});

const action = { key: "gated.pull_request", binding_id: `binding_${ID}` };
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
      prerequisite: { key: "earlier", evidence_id: `evidence_${ID}` },
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
      tool_name: ACTION_REQUEST_TOOL_NAME,
      items,
    }).items,
    items,
  );
  assert.equal(
    actionRequestResultSchema.safeParse({ tool_name: "other", items }).success,
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
    resource_identity: resourceIdentity,
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
      resource_identity: resourceIdentity,
      number: 42,
    }).success,
    true,
  );
  assert.equal(
    platformAddressSchema.safeParse({
      kind: PlatformAddressKind.PullRequest,
      resource_identity: resourceIdentity,
      number: Number.MAX_SAFE_INTEGER + 1,
    }).success,
    false,
  );
});

test("an execution environment refuses a stored or a repository source with no digest", () => {
  const digest = "d".repeat(64);
  assert.equal(executionEnvironmentSchema.parse(null), null);
  assert.ok(
    executionEnvironmentSchema.safeParse({
      source: EnvironmentSource.Stored,
      document: { image: "debian" },
      digest,
    }).success,
  );
  assert.ok(
    executionEnvironmentSchema.safeParse({
      source: EnvironmentSource.Repository,
      digest,
    }).success,
  );
  assert.equal(
    executionEnvironmentSchema.safeParse({
      source: EnvironmentSource.Stored,
      document: { image: "debian" },
    }).success,
    false,
  );
  assert.equal(
    executionEnvironmentSchema.safeParse({
      source: EnvironmentSource.Repository,
    }).success,
    false,
  );
  assert.equal(
    executionEnvironmentSchema.safeParse({
      source: EnvironmentSource.Repository,
      digest: "",
    }).success,
    false,
  );
});
