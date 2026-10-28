import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { clearedChangeRequests } from "./change-request.ts";
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
const SECOND_ATTEMPT = 2;
const BAD_GATEWAY_STATUS = 502;
const RETRYABLE_CODE = "repository.platform.github.retryable_refusal";
const BODY = {
  head_commit: HEAD,
  change_requests: [
    {
      review_id: 7,
      reviewer: "octo",
      body: "Rename the route.",
      submitted_at: null,
      commit_id: HEAD,
      comments: [{ path: "src/route.ts", line: 4, body: "Use /api." }],
    },
  ],
};

function claim(attempt: number): ExecutionClaim {
  return {
    executionId: "execution_1",
    runtimeIdentity: "runtime",
    projectId: "project_1",
    nodeId: "node_1",
    attempt,
    pinnedRevision: 1,
  } as ExecutionClaim;
}

function entry(
  action: string,
  resolution: string,
  evidenceId: string | null,
): ActionContext["actions"][number] {
  return {
    action: { key: `repo.${action}`, binding_id: BINDING_ID, action },
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
        assert.equal(method, ActionReadMethod.ChangeRequestGet);
        reads.evidenceIds.push(evidenceId);
        return answer;
      },
    },
  } as unknown as Pick<
    Dependencies,
    "store" | "missionActions" | "intakeActions"
  >;
}

const call = (attempt: number): IntakeActionCall => ({
  context: background,
  identity: { kind: "client" } as IntakeActionCall["identity"],
  executionId: claim(attempt).executionId,
});

test("a first attempt reads no change request", async () => {
  const reads = { attempt: null, evidenceIds: [] };
  assert.deepEqual(
    await clearedChangeRequests(
      dependencies([], BODY, reads),
      call(1),
      claim(1),
    ),
    { items: [] },
  );
  assert.equal(reads.attempt, null);
  assert.deepEqual(reads.evidenceIds, []);
});

test("the read covers each pull request of the cleared attempt that ended with other", async () => {
  const reads = { attempt: null, evidenceIds: [] };
  const answer = await clearedChangeRequests(
    dependencies(
      [
        entry(
          RepositoryAction.PullRequest,
          ActionResolution.OtherEnd,
          "evidence_1",
        ),
        entry(
          RepositoryAction.PullRequest,
          ActionResolution.ExpectedEnd,
          "evidence_2",
        ),
        entry(
          RepositoryAction.MergePush,
          ActionResolution.OtherEnd,
          "evidence_3",
        ),
        entry(RepositoryAction.PullRequest, ActionResolution.Unrequested, null),
      ],
      { body: BODY, next_cursor: null },
      reads,
    ),
    call(SECOND_ATTEMPT),
    claim(SECOND_ATTEMPT),
  );
  assert.equal(reads.attempt, SECOND_ATTEMPT - 1);
  assert.deepEqual(reads.evidenceIds, ["evidence_1"]);
  assert.deepEqual(answer, {
    items: [{ evidence_id: "evidence_1", binding_id: BINDING_ID, ...BODY }],
  });
});

test("a platform failure of the read answers 502 with its result code", async () => {
  const reads = { attempt: null, evidenceIds: [] };
  await assert.rejects(
    clearedChangeRequests(
      dependencies(
        [
          entry(
            RepositoryAction.PullRequest,
            ActionResolution.OtherEnd,
            "evidence_1",
          ),
        ],
        {
          class: "retryable_refusal",
          code: RETRYABLE_CODE,
          message: "GitHub is unavailable.",
        },
        reads,
      ),
      call(SECOND_ATTEMPT),
      claim(SECOND_ATTEMPT),
    ),
    (error) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code === RETRYABLE_CODE,
  );
});
