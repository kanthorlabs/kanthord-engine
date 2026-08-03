import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NotImplementedLease } from "./not-implemented.ts";
import { LeaseError, type Lease } from "./index.ts";

describe("src/services/lease/not-implemented.test", () => {
  const methodNames = ["acquire", "renew", "release", "expired"] as const;

  for (const methodName of methodNames) {
    it(`${methodName} throws LeaseError(not-implemented)`, () => {
      const lease: Lease = new NotImplementedLease();
      const method = lease[methodName].bind(lease) as (
        ...args: unknown[]
      ) => unknown;
      assert.throws(
        () => {
          method();
        },
        (error: unknown) => {
          if (!(error instanceof LeaseError)) {
            throw error;
          }
          assert.equal(error.code, "not-implemented");
          assert.equal(error.name, "LeaseError");
          return true;
        },
      );
    });
  }
});
