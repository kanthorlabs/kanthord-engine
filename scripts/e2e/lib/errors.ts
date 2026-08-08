export type RunnerErrorCode =
  "invalid-argument" | "tag-reused" | "unavailable" | "assertion-failed";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
