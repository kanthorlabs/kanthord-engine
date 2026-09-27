import assert from "node:assert/strict";
import { test } from "node:test";
import { CodedError, errorCodeSchema } from "../../kernel/errors.ts";
import { unwired } from "./unwired.ts";

test("unwired seams throw a coded composition error naming the seam", () => {
  assert.throws(
    () => unwired("agentProvidersDependentOn")(),
    (error: unknown) => {
      assert.ok(error instanceof CodedError);
      assert.equal(
        error.code,
        errorCodeSchema.parse("system.composition.unwired"),
      );
      assert.match(error.message, /agentProvidersDependentOn/);
      return true;
    },
  );
});
