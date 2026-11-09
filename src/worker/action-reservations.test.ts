import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DispatchReservations,
  ExecutionMutex,
  type ReservationKey,
} from "./action-reservations.ts";
import { ActionResultKind, Uncertainty } from "./contract.ts";

const FIRST_ATTEMPT = 1;
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
