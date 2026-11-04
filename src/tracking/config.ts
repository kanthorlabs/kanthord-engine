import convict, { type Schema } from "convict";
import { isNumber } from "../kernel/values.ts";
import { DEFAULT_AGE_DAYS } from "./contract.ts";

export interface TrackingConfig {
  trace_writable_days: number;
}

export const WRITABLE_DAYS_MAX = 3650;
const WRITABLE_DAYS_MIN = 1;
const WRITABLE_DAYS_FORMAT = "tracking-trace-writable-days";

convict.addFormat({
  name: WRITABLE_DAYS_FORMAT,
  validate(value: unknown) {
    if (
      !isNumber(value) ||
      !Number.isSafeInteger(value) ||
      value < WRITABLE_DAYS_MIN ||
      value > WRITABLE_DAYS_MAX
    )
      throw new Error(
        `expected a safe integer from ${WRITABLE_DAYS_MIN} to ${WRITABLE_DAYS_MAX}`,
      );
  },
});

export const trackingConfigSchema: Schema<TrackingConfig> = {
  trace_writable_days: {
    doc: "The Tracking Service admits the records of an execution during this number of days after its start.",
    format: WRITABLE_DAYS_FORMAT,
    default: DEFAULT_AGE_DAYS,
  },
};
