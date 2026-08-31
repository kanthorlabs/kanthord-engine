import {
  type WorkerHealth,
  WorkerHealthError,
  type WorkerInstance,
} from "./index.ts";

export class NotImplementedWorkerHealth implements WorkerHealth {
  check(
    instance: WorkerInstance,
  ): Promise<{ available: boolean; reason: string | null }> {
    void instance;
    throw new WorkerHealthError(
      "not-implemented",
      "the worker health service is not implemented",
    );
  }
}
