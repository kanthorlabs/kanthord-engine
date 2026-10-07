import type { Schema } from "convict";
import { isNumber } from "../kernel/values.ts";

export interface WorkerConfig {
  heartbeatWindow: number;
}

const DEFAULT_HEARTBEAT_WINDOW = 300;
const NO_HEARTBEAT_WINDOW = 0;

export const workerConfigSchema: Schema<WorkerConfig> = {
  heartbeatWindow: {
    doc: "Registration heartbeat window in seconds.",
    format(value: unknown) {
      if (
        !isNumber(value) ||
        !Number.isSafeInteger(value) ||
        value <= NO_HEARTBEAT_WINDOW
      )
        throw new Error("expected a positive safe integer");
    },
    default: DEFAULT_HEARTBEAT_WINDOW,
  },
};
