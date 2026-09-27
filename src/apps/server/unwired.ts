import { CodedError } from "../../kernel/errors.ts";

const UNWIRED_ERROR_CODE = "system.composition.unwired";

export function unwired(seam: string): (...args: never[]) => never {
  return () => {
    throw new CodedError(UNWIRED_ERROR_CODE, seam + " is not wired.");
  };
}
