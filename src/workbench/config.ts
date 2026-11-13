import convict, { type Schema } from "convict";
import { isNumber } from "../kernel/values.ts";

export interface WorkbenchConfig {
  approval_wait_ms: number;
}

export const DEFAULT_APPROVAL_WAIT_MS = 3600000;
export const MIN_APPROVAL_WAIT_MS = 60000;
export const MAX_APPROVAL_WAIT_MS = 86400000;
const APPROVAL_WAIT_FORMAT = "workbench-approval-wait";

convict.addFormat({
  name: APPROVAL_WAIT_FORMAT,
  validate(value: unknown) {
    if (
      !isNumber(value) ||
      !Number.isSafeInteger(value) ||
      value < MIN_APPROVAL_WAIT_MS ||
      value > MAX_APPROVAL_WAIT_MS
    )
      throw new Error("expected an integer from 60000 to 86400000");
  },
});

export const workbenchConfigSchema: Schema<WorkbenchConfig> = {
  approval_wait_ms: {
    doc: "Maximum wait of a pending tool call approval in milliseconds. At the end the call returns blocked and the run ends.",
    format: APPROVAL_WAIT_FORMAT,
    default: DEFAULT_APPROVAL_WAIT_MS,
  },
};
