import {
  VerifyError,
  type Verify,
  type CheckRequest,
  type CheckOutput,
} from "./index.ts";

export class NotImplementedVerify implements Verify {
  run(request: CheckRequest): Promise<CheckOutput> {
    void request;
    throw new VerifyError(
      "not-implemented",
      "the verify service is implemented in phase 2",
    );
  }
}
