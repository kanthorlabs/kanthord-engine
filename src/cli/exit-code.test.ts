import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_REFUSAL,
  TRANSPORT_FAILURE,
  REFUSED_BY_DAEMON,
  DAEMON_FAULT,
  exitCodes,
  exitCodeForError,
} from "./exit-code.ts";
import { errorStatuses } from "../http/contract/errors.ts";

const expected: Readonly<Record<string, number>> = {
  "invalid-request": 110,
  unauthenticated: 120,
  "origin-forbidden": 130,
  "host-forbidden": 131,
  "actor-forbidden": 132,
  "not-found": 140,
  "stale-revision": 150,
  "illegal-transition": 151,
  "binding-in-use": 152,
  "needs-reconcile": 153,
  "acknowledgement-required": 154,
  "lease-held": 155,
  "idempotency-mismatch": 156,
  "choices-stale": 157,
  "choices-changed": 158,
  "host-key-mismatch": 159,
  "plan-invalid": 160,
  "choices-invalid": 161,
  "identity-kind-mismatch": 162,
  "credential-rejected": 163,
  "internal-error": 210,
  "not-implemented": 220,
  "service-unavailable": 230,
};

const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

describe("src/cli/exit-code.test", () => {
  it("exitCodes keys match errorStatuses keys bytewise", () => {
    const codes = Object.keys(exitCodes).sort(bytewise);
    const statuses = Object.keys(errorStatuses).sort(bytewise);

    assert.deepEqual(codes, statuses);
  });

  it("each of the twenty-three codes maps to its literal exit code", () => {
    let count = 0;
    for (const [code, status] of Object.entries(errorStatuses)) {
      assert.equal(
        exitCodeForError(code, status),
        expected[code],
        `exit code for ${code}`,
      );
      count += 1;
    }
    assert.equal(count, 23);
  });

  it("every value is an integer between 1 and 255 and 0 never appears", () => {
    for (const value of Object.values(exitCodes)) {
      assert.equal(Number.isInteger(value), true);
      assert.ok(value >= 1, `value ${value} must be at least 1`);
      assert.ok(value <= 255, `value ${value} must be at most 255`);
    }
    assert.equal(Object.values(exitCodes).includes(0), false);
  });

  it("the ceiling: the largest exit code is at most 255", () => {
    assert.ok(Math.max(...Object.values(exitCodes)) <= 255);
  });

  it("every code takes its status base plus its position in that status group", () => {
    const base: Readonly<Record<number, number>> = {
      400: 110,
      401: 120,
      403: 130,
      404: 140,
      409: 150,
      422: 160,
      500: 210,
      501: 220,
      503: 230,
    };
    const distinctStatuses = [...new Set(Object.values(errorStatuses))].sort(
      (a, b) => a - b,
    );
    assert.deepEqual(
      distinctStatuses,
      Object.keys(base)
        .map(Number)
        .sort((a, b) => a - b),
    );
    const entries = Object.entries(errorStatuses);
    for (const [code, status] of entries) {
      const group = entries.filter(([, entryStatus]) => entryStatus === status);
      const index = group.findIndex(([groupCode]) => groupCode === code);
      const value = (exitCodes as Readonly<Record<string, number>>)[code]!;
      assert.equal(value, base[status]! + index, `${code} exit code`);
    }
  });

  it("no two codes share an exit code", () => {
    assert.equal(new Set(Object.values(exitCodes)).size, 23);
  });

  it("unknown codes fall to the category floor", () => {
    assert.equal(exitCodeForError("invented-future-code", 409), 100);
    assert.equal(exitCodeForError("invented-future-code", 503), 200);
    assert.equal(exitCodeForError("invented-future-code", 302), 1);
    assert.equal(exitCodeForError("", 0), 1);
  });

  it("the four exported constants are pinned", () => {
    assert.equal(LOCAL_REFUSAL, 1);
    assert.equal(TRANSPORT_FAILURE, 2);
    assert.equal(REFUSED_BY_DAEMON, 100);
    assert.equal(DAEMON_FAULT, 200);
  });

  it("not-implemented is 220", () => {
    assert.equal(exitCodes["not-implemented"], 220);
  });

  it("service-unavailable is 230", () => {
    assert.equal(exitCodeForError("service-unavailable", 503), 230);
  });
});
