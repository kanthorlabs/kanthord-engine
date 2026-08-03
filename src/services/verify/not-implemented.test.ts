import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NotImplementedVerify } from "./not-implemented.ts";
import { VerifyError, type CheckRequest } from "./index.ts";

const request: CheckRequest = {
  checkName: "typecheck",
  command: ["npm", "run", "typecheck"],
  cwd: "/tmp/workspace",
  env: {},
  timeoutMs: 1000,
  outputLimitBytes: 1024,
};

describe("src/services/verify/not-implemented.test", () => {
  it("run throws VerifyError(not-implemented)", () => {
    const verify = new NotImplementedVerify();
    assert.throws(
      () => {
        verify.run(request);
      },
      (error: unknown) => {
        if (!(error instanceof VerifyError)) {
          throw error;
        }
        assert.equal(error.code, "not-implemented");
        assert.equal(error.name, "VerifyError");
        return true;
      },
    );
  });
});
