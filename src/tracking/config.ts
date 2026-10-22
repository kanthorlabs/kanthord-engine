import convict, { type Schema } from "convict";
import { isNumber } from "../kernel/values.ts";

export interface TrackingConfig {
  retention_days: number;
}

export const DEFAULT_RETENTION_DAYS = 30;
export const RETENTION_DAYS_MAX = 3650;
const RETENTION_DAYS_MIN = 1;
const RETENTION_DAYS_FORMAT = "tracking-retention-days";

convict.addFormat({
  name: RETENTION_DAYS_FORMAT,
  validate(value: unknown) {
    if (
      !isNumber(value) ||
      !Number.isSafeInteger(value) ||
      value < RETENTION_DAYS_MIN ||
      value > RETENTION_DAYS_MAX
    )
      throw new Error(
        `expected a safe integer from ${RETENTION_DAYS_MIN} to ${RETENTION_DAYS_MAX}`,
      );
  },
});

export const trackingConfigSchema: Schema<TrackingConfig> = {
  retention_days: {
    doc: "Retention of a trace in days, from the creation of the trace.",
    format: RETENTION_DAYS_FORMAT,
    default: DEFAULT_RETENTION_DAYS,
  },
};
