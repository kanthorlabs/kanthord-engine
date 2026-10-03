import { CodedError } from "../kernel/errors.ts";
import {
  EndReason,
  ExecutionEndKind,
  ExecutionStop,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import type { NativeAgent } from "./native-agent.ts";

export function stopOnEnd(run: ExecutionRun, agent: NativeAgent): () => void {
  return run.onStop(() => void agent.abort());
}

export async function executionBoundary(
  run: ExecutionRun,
  invoke: () => Promise<ExecutionEnd>,
): Promise<ExecutionEnd> {
  try {
    return await invoke();
  } catch (error) {
    if (error instanceof ExecutionStop)
      return {
        kind: ExecutionEndKind.Ended,
        reason: error.reason,
        code: error.code,
      };
    try {
      run.stop(
        EndReason.OperationFailed,
        error instanceof CodedError ? error.code : null,
      );
    } catch (stopped) {
      if (!(stopped instanceof ExecutionStop)) throw stopped;
      return {
        kind: ExecutionEndKind.Ended,
        reason: stopped.reason,
        code: stopped.code,
      };
    }
  }
}
