import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { failedChecks } from "./failed-check.ts";
import {
  type ActionContext,
  ActionReadMethod,
  ActionResolution,
  type IntakeActionCall,
  RepositoryAction,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";

const HEAD = "a".repeat(40);
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const ATTEMPT = 2;
const BAD_GATEWAY_STATUS = 502;
const RETRYABLE_CODE = "repository.platform.github.retryable_refusal";
const CLAIM = {
  executionId: "execution_1",
  runtimeIdentity: "runtime",
  projectId: "project_1",
  nodeId: "node_1",
  attempt: ATTEMPT,
  pinnedRevision: 1,
} as ExecutionClaim;
const CALL: IntakeActionCall = {
  context: background,
  identity: { kind: "client" } as IntakeActionCall["identity"],
  executionId: CLAIM.executionId,
};

function body(pending: string[], failed: string[]) {
  return {
    body: {
      head_commit: HEAD,
      base_branch: "main",
      pending,
      failed,
    },
    next_cursor: null,
  };
}

function entry(
  resolution: string,
  evidenceId: string | null,
): ActionContext["actions"][number] {
  return {
    action: {
      key: "repo.pull_request",
      binding_id: BINDING_ID,
      action: RepositoryAction.PullRequest,
    },
    resource_identity: "owner/repo",
    resolution,
    request_evidence_id: evidenceId,
    eligible: false,
    reuse_candidates: [],
  } as unknown as ActionContext["actions"][number];
}

function dependencies(
  actions: ActionContext["actions"],
  answer: unknown,
  reads: { attempt: number | null; evidenceIds: string[] },
) {
  return {
    store: { transaction: (work: (tx: unknown) => unknown) => work({}) },
    missionActions: {
      actionContextOf: (_tx: unknown, _nodeId: string, attempt: number) => {
        reads.attempt = attempt;
        return { actions } as ActionContext;
      },
    },
    intakeActions: {
      read: async (
        _call: IntakeActionCall,
        method: string,
        evidenceId: string,
      ) => {
        assert.equal(method, ActionReadMethod.RequiredCheckGet);
        reads.evidenceIds.push(evidenceId);
        return answer;
      },
    },
  } as unknown as Pick<
    Dependencies,
    "store" | "missionActions" | "intakeActions"
  >;
}

test("an unresolved pull request with a failed check gives one item", async () => {
  const reads = { attempt: null, evidenceIds: [] };
  const answer = await failedChecks(
    dependencies(
      [entry(ActionResolution.Unresolved, "evidence_1")],
      body(["slow"], ["lint", "unit"]),
      reads,
    ),
    CALL,
    CLAIM,
  );
  assert.equal(reads.attempt, ATTEMPT);
  assert.deepEqual(reads.evidenceIds, ["evidence_1"]);
  assert.deepEqual(answer, {
    items: [
      {
        evidence_id: "evidence_1",
        binding_id: BINDING_ID,
        head_commit: HEAD,
        failed: ["lint", "unit"],
      },
    ],
  });
});

test("a request with only pending checks gives no item", async () => {
  const reads = { attempt: null, evidenceIds: [] };
  assert.deepEqual(
    await failedChecks(
      dependencies(
        [entry(ActionResolution.Unresolved, "evidence_1")],
        body(["slow"], []),
        reads,
      ),
      CALL,
      CLAIM,
    ),
    { items: [] },
  );
  assert.deepEqual(reads.evidenceIds, ["evidence_1"]);
});

test("a resolved request is not read", async () => {
  const reads = { attempt: null, evidenceIds: [] };
  assert.deepEqual(
    await failedChecks(
      dependencies(
        [
          entry(ActionResolution.ExpectedEnd, "evidence_1"),
          entry(ActionResolution.OtherEnd, "evidence_2"),
          entry(ActionResolution.Unrequested, null),
        ],
        body([], ["lint"]),
        reads,
      ),
      CALL,
      CLAIM,
    ),
    { items: [] },
  );
  assert.deepEqual(reads.evidenceIds, []);
});

test("a platform failure of the read answers 502 with its result code", async () => {
  const reads = { attempt: null, evidenceIds: [] };
  await assert.rejects(
    failedChecks(
      dependencies(
        [entry(ActionResolution.Unresolved, "evidence_1")],
        {
          class: "retryable_refusal",
          code: RETRYABLE_CODE,
          message: "GitHub is unavailable.",
        },
        reads,
      ),
      CALL,
      CLAIM,
    ),
    (error) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code === RETRYABLE_CODE,
  );
});
