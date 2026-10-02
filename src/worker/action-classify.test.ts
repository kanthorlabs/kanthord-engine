import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OperationResultType,
  type OperationResult,
} from "../kernel/operation.ts";
import {
  ActionResultKind,
  PlatformAddressKind,
  RefusalClass,
  ResultClass,
  Uncertainty,
} from "./contract.ts";
import {
  performedItem,
  readRefusalItem,
  recordedItem,
  isResultClass,
} from "./action-classify.ts";

const ref = { key: "repo.pull_request", bindingId: "binding" };
const address = {
  kind: PlatformAddressKind.PullRequest,
  resourceIdentity: "repository:github:owner/repo",
  number: 42,
};
const refusal = {
  class: RefusalClass.FinalRefusal,
  code: "repository.platform.github.final_refusal",
  message: "refused",
};

test("perform distinguishes no-effect refusals, unknown effects and addresses", () => {
  for (const resultClass of Object.values(RefusalClass)) {
    const answer = { ...refusal, class: resultClass };
    assert.deepEqual(performedItem(ref, answer), {
      kind: ActionResultKind.FailedBeforeEffect,
      action: ref,
      refusal: answer,
    });
  }
  assert.deepEqual(
    performedItem(ref, { ...refusal, class: ResultClass.UnknownOutcome }),
    {
      kind: ActionResultKind.Uncertain,
      action: ref,
      uncertainty: Uncertainty.Effect,
    },
  );
  assert.equal(performedItem(ref, address), null);
  assert.equal(isResultClass(address), false);
  assert.equal(isResultClass(refusal), true);
});

test("a read never reports a possible write effect and preserves refusal details", () => {
  for (const resultClass of Object.values(ResultClass)) {
    const answer = { ...refusal, class: resultClass };
    assert.deepEqual(readRefusalItem(ref, answer), {
      kind: ActionResultKind.FailedBeforeEffect,
      action: ref,
      refusal: {
        ...answer,
        class:
          resultClass === ResultClass.UnknownOutcome
            ? RefusalClass.ConfirmedFailure
            : resultClass,
      },
    });
  }
  assert.equal(isResultClass({ body: {} }), false);
});

test("recording returns exact evidence or preserves the known remote address", () => {
  const evidence = { id: "evidence", attempt: 1, assets: [{ address }] };
  assert.deepEqual(
    recordedItem(ref, address, {
      type: OperationResultType.Completed,
      status: 200,
      data: evidence,
    }),
    { kind: ActionResultKind.Submitted, evidence },
  );
  const refusals: OperationResult<unknown>[] = [
    {
      type: OperationResultType.Failure,
      status: 409,
      error: {
        error: {
          code: "mission.request.exists",
          message: "exists",
          details: null,
        },
        requestId: "request",
      },
    },
    { type: OperationResultType.Indeterminate },
  ];
  for (const result of refusals)
    assert.deepEqual(recordedItem(ref, address, result), {
      kind: ActionResultKind.Uncertain,
      action: ref,
      uncertainty: Uncertainty.Recording,
      address,
    });
});
