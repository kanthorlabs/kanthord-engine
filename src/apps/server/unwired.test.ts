import assert from "node:assert/strict";
import { test } from "node:test";
import { CodedError, errorCodeSchema } from "../../kernel/errors.ts";
import { unwired } from "./unwired.ts";

const SEAM = "SchedulerClaims.revoke";
const CODE = "system.composition.unwired";

test("unwired throws an internal coded error naming the absent collaboration", () => {
  assert.throws(
    () => unwired(SEAM)(),
    (error: unknown) => {
      assert.ok(error instanceof CodedError);
      assert.equal(error.code, errorCodeSchema.parse(CODE));
      assert.equal(error.message, `${SEAM} is not wired.`);
      return true;
    },
  );
});
