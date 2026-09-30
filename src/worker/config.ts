import type { Schema } from "convict";
import { isNumber, isString } from "../kernel/values.ts";

export interface WorkerConfig {
  heartbeatWindow: number;
  globalPrompt: string;
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
  globalPrompt: {
    doc: "Global prompt Markdown path; empty is absent and - disables the layer.",
    format(value: unknown) {
      if (!isString(value)) throw new Error("expected a string");
    },
    default: "",
  },
};
