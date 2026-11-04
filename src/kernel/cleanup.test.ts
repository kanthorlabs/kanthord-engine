import assert from "node:assert/strict";
import { test } from "node:test";
import { FOOTPRINT_SERVICE, requesterOf } from "./cleanup.ts";
import { OperationError } from "./errors.ts";
import { HttpStatus } from "./http.ts";
import { createIdentity } from "./identity.ts";
import {
  testHumanIdentity,
  testServiceIdentity,
  testWorkerIdentity,
} from "./test-identity.ts";

const ACTOR = { kind: "human" as const, account: "ulrich", name: "Ulrich" };
const VALIDATION_FAILED = "gateway.request.validation_failed";
const HUMAN = testHumanIdentity("ulrich", "Ulrich", "jti-ulrich");

function refusesRequestedBy(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, HttpStatus.BadRequest);
    assert.equal(error.code, VALIDATION_FAILED);
    assert.deepEqual(error.details, [
      { path: ["body", "requested_by"], code: "custom" },
    ]);
    return true;
  });
}

test("requesterOf takes the human caller and the requested_by of a service caller", () => {
  assert.deepEqual(requesterOf(HUMAN, undefined), ACTOR);
  assert.deepEqual(
    requesterOf(testServiceIdentity(FOOTPRINT_SERVICE), ACTOR),
    ACTOR,
  );
});

test("requesterOf refuses requested_by from a human, a service caller without it and every other caller", () => {
  refusesRequestedBy(() => requesterOf(HUMAN, ACTOR));
  refusesRequestedBy(() =>
    requesterOf(testServiceIdentity(FOOTPRINT_SERVICE), undefined),
  );
  const worker = testWorkerIdentity(
    createIdentity("worker_instance"),
    "e2e-coder-1",
    "jti-worker",
  );
  refusesRequestedBy(() => requesterOf(worker, ACTOR));
  refusesRequestedBy(() => requesterOf(undefined, undefined));
});
