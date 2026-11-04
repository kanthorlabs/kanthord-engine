import convict, { type Schema } from "convict";
import { isNumber } from "../kernel/values.ts";

export interface FootprintConfig {
  disk_free_ratio: number;
}

export const DEFAULT_DISK_FREE_RATIO = 0.1;
const RATIO_MIN = 0;
const RATIO_MAX = 1;
const DISK_FREE_RATIO_FORMAT = "footprint-disk-free-ratio";

convict.addFormat({
  name: DISK_FREE_RATIO_FORMAT,
  validate(value: unknown) {
    if (!isNumber(value) || !(value > RATIO_MIN && value < RATIO_MAX))
      throw new Error(
        `expected a number above ${RATIO_MIN} and below ${RATIO_MAX}`,
      );
  },
});

export const footprintConfigSchema: Schema<FootprintConfig> = {
  disk_free_ratio: {
    doc: "The disk alert fires when the free bytes of a device fall below this part of its total bytes.",
    format: DISK_FREE_RATIO_FORMAT,
    default: DEFAULT_DISK_FREE_RATIO,
  },
};
