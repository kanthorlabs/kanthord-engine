import type { Schema } from "convict";
import { isNumber } from "../kernel/values.ts";

export interface WorkerConfig {
  heartbeat_window: number;
  server_slot_limit: number;
}

const DEFAULT_HEARTBEAT_WINDOW = 300;
const DEFAULT_SERVER_SLOT_LIMIT = 16;
const NO_VALUE = 0;

function positiveSafeInteger(value: unknown): void {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value <= NO_VALUE)
    throw new Error("expected a positive safe integer");
}

export const workerConfigSchema: Schema<WorkerConfig> = {
  heartbeat_window: {
    doc: "Registration heartbeat window in seconds.",
    format: positiveSafeInteger,
    default: DEFAULT_HEARTBEAT_WINDOW,
  },
  server_slot_limit: {
    doc: "Maximum count of started pool slots of the server.",
    format: positiveSafeInteger,
    default: DEFAULT_SERVER_SLOT_LIMIT,
  },
};
