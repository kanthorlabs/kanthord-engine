import type { Schema } from "convict";

export interface MissionConfig {
  consecutive_failure_limit: number;
  text_max_bytes: number;
}

const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 3;
const DEFAULT_TEXT_MAX_BYTES = 32768;

export const missionConfigSchema: Schema<MissionConfig> = {
  consecutive_failure_limit: {
    doc: "Consecutive lost or stopped executions that the Mission Service permits before it pauses the node.",
    format: "nat",
    default: DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  },
  text_max_bytes: {
    doc: "Maximum size of mission text in bytes.",
    format: "nat",
    default: DEFAULT_TEXT_MAX_BYTES,
  },
};
