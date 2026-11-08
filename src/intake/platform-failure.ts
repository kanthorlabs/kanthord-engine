import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { ResultClass, type ResultClassValue } from "./contract.ts";
import type { Platform } from "./credential-platform.ts";

const BAD_GATEWAY_STATUS = 502;

export const PLATFORM_FAILURE_CODE_PREFIX = "intake.platform.";

export function platformFailureCode(
  platform: Platform,
  resultClass: ResultClassValue,
): string {
  return `${PLATFORM_FAILURE_CODE_PREFIX}${platform}.${resultClass}`;
}

export interface PlatformFailure {
  class: ResultClassValue;
  message: string;
  status: number | null;
}

export function platformFailure(
  platform: Platform,
  failure: PlatformFailure,
): OperationError {
  assert.ok(Object.values(ResultClass).includes(failure.class));
  return new OperationError(
    BAD_GATEWAY_STATUS,
    platformFailureCode(platform, failure.class),
    failure.message,
    { status: failure.status },
  );
}
