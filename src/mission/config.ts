import type { Schema } from "convict";

export interface MissionConfig {
  consecutive_failure_limit: number;
  further_work_limit: number;
  rework_limit: number;
  text_max_bytes: number;
}

const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 3;
const DEFAULT_REWORK_LIMIT = 2;
const DEFAULT_FURTHER_WORK_LIMIT = 3;
const DEFAULT_TEXT_MAX_BYTES = 32768;

export const missionConfigSchema: Schema<MissionConfig> = {
  consecutive_failure_limit: {
    doc: "Consecutive lost or stopped executions that the Mission Service permits before it pauses the node.",
    format: "nat",
    default: DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  },
  further_work_limit: {
    doc: "Consecutive further-work releases of one attempt that pass no new task before the Mission Service pauses the node. The value 0 turns the limit off.",
    format: "nat",
    default: DEFAULT_FURTHER_WORK_LIMIT,
  },
  rework_limit: {
    doc: "Reworks of an attempt that the Mission Service permits before a criterion-not-met assessment blocks the node. The value 0 turns rework off.",
    format: "nat",
    default: DEFAULT_REWORK_LIMIT,
  },
  text_max_bytes: {
    doc: "Maximum size of mission text in bytes.",
    format: "nat",
    default: DEFAULT_TEXT_MAX_BYTES,
  },
};
