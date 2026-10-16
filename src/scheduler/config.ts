import convict, { type Schema } from "convict";
import { isNumber } from "../kernel/values.ts";

export interface SchedulerConfig {
  release_reserve: number;
  stop_backoff: number;
}

export const DEFAULT_RELEASE_RESERVE_SECONDS = 600;
export const DEFAULT_STOP_BACKOFF_SECONDS = 30;
const NO_RESERVE = 0;
const RELEASE_RESERVE_FORMAT = "scheduler-release-reserve";

convict.addFormat({
  name: RELEASE_RESERVE_FORMAT,
  validate(value: unknown) {
    if (!isNumber(value) || !Number.isSafeInteger(value) || value <= NO_RESERVE)
      throw new Error("expected a positive safe integer");
  },
});

export const schedulerConfigSchema: Schema<SchedulerConfig> = {
  release_reserve: {
    doc: "Reserve after the effective worker wall time, in seconds.",
    format: RELEASE_RESERVE_FORMAT,
    default: DEFAULT_RELEASE_RESERVE_SECONDS,
  },
  stop_backoff: {
    doc: "Wait before the next claim of a node after its first consecutive failure, in seconds. It doubles with each further failure.",
    format: RELEASE_RESERVE_FORMAT,
    default: DEFAULT_STOP_BACKOFF_SECONDS,
  },
};
