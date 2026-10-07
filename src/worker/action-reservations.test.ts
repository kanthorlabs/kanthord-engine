import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DispatchReservations,
  ExecutionMutex,
  type ReservationKey,
} from "./action-reservations.ts";
import {
  ActionResolution,
  ActionResultKind,
  Uncertainty,
  type ActionContext,
} from "./contract.ts";

const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const SECOND_MUTEX_RESULT = 2;
const key: ReservationKey = {
  nodeId: "node",
  attempt: FIRST_ATTEMPT,
  action: { key: "repo.pull_request", binding_id: "binding" },
};
const uncertain = {
  kind: ActionResultKind.Uncertain,
  action: key.action,
  uncertainty: Uncertainty.Recording,
};

test("mutex serializes one execution and frees it after rejection", async () => {
  const mutex = new ExecutionMutex();
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const first = mutex.run("execution", async () => {
    calls.push("first");
    await gate.promise;
    throw new Error("failed");
  });
  const failure = assert.rejects(first, /failed/);
  const second = mutex.run("execution", async () => {
    calls.push("second");
    return SECOND_MUTEX_RESULT;
  });
  assert.deepEqual(calls, ["first"]);
  gate.resolve();
  await failure;
  assert.equal(await second, SECOND_MUTEX_RESULT);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(
    await mutex.run("execution", async () => FIRST_ATTEMPT),
    FIRST_ATTEMPT,
  );
});

test("mutex permits different executions to overlap", async () => {
  const mutex = new ExecutionMutex();
  const gate = Promise.withResolvers<void>();
  const first = mutex.run("first", () => gate.promise);
  assert.equal(
    await mutex.run("second", async () => SECOND_MUTEX_RESULT),
    SECOND_MUTEX_RESULT,
  );
  gate.resolve();
  assert.equal(await first, undefined);
});

test("in-flight contender leaves the owner able to settle", () => {
  const reservations = new DispatchReservations();
  const acquired = reservations.acquire(key);
  assert.ok("owner" in acquired);
  assert.deepEqual(reservations.acquire(key), {
    held: { ...uncertain, uncertainty: Uncertainty.Effect },
  });
  reservations.settle(key, acquired.owner, uncertain);
  assert.deepEqual(reservations.acquire(key), { held: uncertain });
});

test("foreign settlement cannot remove or replace an owned reservation", () => {
  const reservations = new DispatchReservations();
  const acquired = reservations.acquire(key);
  assert.ok("owner" in acquired);
  reservations.settle(key, Symbol("foreign"), null);
  assert.ok("held" in reservations.acquire(key));
  reservations.settle(key, acquired.owner, null);
  assert.ok("owner" in reservations.acquire(key));
});

test("uncertain settlement is retained unchanged across callers", () => {
  const reservations = new DispatchReservations();
  const acquired = reservations.acquire(key);
  assert.ok("owner" in acquired);
  reservations.settle(key, acquired.owner, uncertain);
  reservations.settle(key, acquired.owner, null);
  assert.deepEqual(reservations.acquire(key), { held: uncertain });
});

test("prune clears only requested actions in the same attempt", () => {
  const reservations = new DispatchReservations();
  reservations.acquire(key);
  reservations.acquire({ ...key, attempt: SECOND_ATTEMPT });
  const action = {
    key: key.action.key,
    binding_id: key.action.binding_id,
    action: "pull_request",
    expected_end_state: "pull_request_merged",
    follows: null,
    configuration: { base_branch: "main" },
  } as const;
  const entries: ActionContext["actions"] = [
    {
      action,
      resource_identity: "repository:github:owner/repo",
      resolution: ActionResolution.Unrequested,
      request_evidence_id: null,
      eligible: true,
      reuse_candidates: [],
    },
  ];
  reservations.prune(key.nodeId, FIRST_ATTEMPT, entries);
  assert.ok("held" in reservations.acquire(key));
  entries[0]!.resolution = ActionResolution.Unresolved;
  entries[0]!.request_evidence_id = "evidence";
  reservations.prune(key.nodeId, FIRST_ATTEMPT, entries);
  assert.ok("owner" in reservations.acquire(key));
  assert.ok(
    "held" in reservations.acquire({ ...key, attempt: SECOND_ATTEMPT }),
  );
});
