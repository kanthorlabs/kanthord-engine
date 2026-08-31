export type WorkerInstance = Readonly<{
  worker: string;
  instanceId: string;
}>;

export type WorkerHealthErrorCode = "not-implemented";

export class WorkerHealthError extends Error {
  readonly code: WorkerHealthErrorCode;
  constructor(code: WorkerHealthErrorCode, message: string) {
    super(message);
    this.name = "WorkerHealthError";
    this.code = code;
  }
}

export interface WorkerHealth {
  check(
    instance: WorkerInstance,
  ): Promise<{ available: boolean; reason: string | null }>;
}
