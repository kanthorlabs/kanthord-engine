import type { Schema } from "convict";

export interface MissionConfig {
  consecutiveLossLimit: number;
  textMaxBytes: number;
}

const DEFAULT_CONSECUTIVE_LOSS_LIMIT = 3;
const DEFAULT_TEXT_MAX_BYTES = 32768;

export const missionConfigSchema: Schema<MissionConfig> = {
  consecutiveLossLimit: {
    doc: "Consecutive losses permitted before a mission is paused.",
    format: "nat",
    default: DEFAULT_CONSECUTIVE_LOSS_LIMIT,
  },
  textMaxBytes: {
    doc: "Maximum size of mission text in bytes.",
    format: "nat",
    default: DEFAULT_TEXT_MAX_BYTES,
  },
};
