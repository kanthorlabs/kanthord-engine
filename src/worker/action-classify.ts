import assert from "node:assert/strict";
import {
  OperationResultType,
  type OperationResult,
} from "../kernel/operation.ts";
import { isObject } from "../kernel/values.ts";
import {
  ActionResultKind,
  RefusalClass,
  ResultClass,
  Uncertainty,
  type ActionRef,
  type ActionResultItem,
  type PlatformAddress,
  type ResultClassAnswer,
} from "./contract.ts";

export function isResultClass(
  answer: PlatformAddress | { body: unknown } | ResultClassAnswer,
): answer is ResultClassAnswer {
  assert.ok(isObject(answer));
  assert.ok(!Array.isArray(answer));
  return "class" in answer;
}

export function performedItem(
  ref: ActionRef,
  answer: PlatformAddress | ResultClassAnswer,
): ActionResultItem | null {
  assert.ok(ref.key);
  assert.ok(ref.bindingId);
  if (!isResultClass(answer)) return null;
  if (answer.class === ResultClass.UnknownOutcome)
    return {
      kind: ActionResultKind.Uncertain,
      action: ref,
      uncertainty: Uncertainty.Effect,
    };
  return {
    kind: ActionResultKind.FailedBeforeEffect,
    action: ref,
    refusal: {
      class: answer.class,
      code: answer.code,
      message: answer.message,
    },
  };
}

export function readRefusalItem(
  ref: ActionRef,
  answer: ResultClassAnswer,
): ActionResultItem {
  assert.ok(ref.key);
  assert.ok(ref.bindingId);
  return {
    kind: ActionResultKind.FailedBeforeEffect,
    action: ref,
    refusal: {
      class:
        answer.class === ResultClass.UnknownOutcome
          ? RefusalClass.ConfirmedFailure
          : answer.class,
      code: answer.code,
      message: answer.message,
    },
  };
}

export function recordedItem(
  ref: ActionRef,
  address: PlatformAddress,
  result: OperationResult<unknown>,
): ActionResultItem {
  assert.ok(ref.key);
  assert.ok(address.resourceIdentity);
  if (result.type === OperationResultType.Completed) {
    assert.ok(isObject(result.data) && !Array.isArray(result.data));
    return {
      kind: ActionResultKind.Submitted,
      evidence: result.data as Record<string, unknown>,
    };
  }
  return {
    kind: ActionResultKind.Uncertain,
    action: ref,
    uncertainty: Uncertainty.Recording,
    address,
  };
}
