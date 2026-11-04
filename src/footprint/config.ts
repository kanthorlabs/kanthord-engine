import convict, { type Schema } from "convict";
import { isNumber } from "../kernel/values.ts";
import { FootprintKind } from "./contract.ts";

export type ThresholdKind = Exclude<FootprintKind, typeof FootprintKind.Disk>;
export type FootprintThresholds = Record<ThresholdKind, number | null>;

export interface FootprintConfig {
  disk_free_ratio: number;
  thresholds: FootprintThresholds;
}

export const DEFAULT_DISK_FREE_RATIO = 0.1;
export const DEFAULT_TRACE_THRESHOLD_BYTES = 8589934592;
export const DEFAULT_LOG_THRESHOLD_BYTES = 2147483648;
const RATIO_MIN = 0;
const RATIO_MAX = 1;
const THRESHOLD_MIN = 1;
const DISK_FREE_RATIO_FORMAT = "footprint-disk-free-ratio";
const THRESHOLD_FORMAT = "footprint-threshold-bytes";

convict.addFormat({
  name: DISK_FREE_RATIO_FORMAT,
  validate(value: unknown) {
    if (!isNumber(value) || !(value > RATIO_MIN && value < RATIO_MAX))
      throw new Error(
        `expected a number above ${RATIO_MIN} and below ${RATIO_MAX}`,
      );
  },
});

convict.addFormat({
  name: THRESHOLD_FORMAT,
  validate(value: unknown) {
    if (
      value !== null &&
      (!isNumber(value) ||
        !Number.isSafeInteger(value) ||
        value < THRESHOLD_MIN)
    )
      throw new Error("expected a positive safe integer of bytes or null");
  },
});

export const THRESHOLD_KINDS = Object.values(FootprintKind).filter(
  (kind): kind is ThresholdKind => kind !== FootprintKind.Disk,
);

export const DEFAULT_THRESHOLDS: Readonly<FootprintThresholds> = {
  ...(Object.fromEntries(
    THRESHOLD_KINDS.map((kind) => [kind, null]),
  ) as FootprintThresholds),
  [FootprintKind.Trace]: DEFAULT_TRACE_THRESHOLD_BYTES,
  [FootprintKind.Log]: DEFAULT_LOG_THRESHOLD_BYTES,
};

export const footprintConfigSchema: Schema<FootprintConfig> = {
  disk_free_ratio: {
    doc: "The disk alert fires when the free bytes of a device fall below this part of its total bytes.",
    format: DISK_FREE_RATIO_FORMAT,
    default: DEFAULT_DISK_FREE_RATIO,
  },
  thresholds: Object.fromEntries(
    THRESHOLD_KINDS.map((kind) => [
      kind,
      {
        doc: `The bytes alert of the ${kind} kind fires above this number of bytes. The value null turns it off.`,
        format: THRESHOLD_FORMAT,
        default: DEFAULT_THRESHOLDS[kind],
      },
    ]),
  ) as Schema<FootprintThresholds>,
};
