import {
  FOOTPRINT_ALERT_CLEAR_RATIO,
  FOOTPRINT_ALERT_CONFIRMATIONS,
  FootprintAlertState,
  FootprintKind,
  type FootprintStat,
  type FootprintThreshold,
  ThresholdMeasure,
} from "./contract.ts";

const HALF = 2;
const DOUBLE = 2;
const NO_STREAK = 0;
const FIRST_STREAK = 1;
const NO_BYTES = 0;

export type AlertSubject = Pick<
  FootprintStat,
  | "kind"
  | "bytes"
  | "free_bytes"
  | "total_bytes"
  | "days_to_floor"
  | "stale"
  | "measure_error"
  | "thresholds"
>;

export interface AlertTrack {
  readonly state: FootprintAlertState;
  readonly streak: number;
  readonly threshold: FootprintThreshold | null;
}

export type AlertEvent =
  | { readonly fire: true; threshold: FootprintThreshold; value: number }
  | { readonly fire: false };

export interface AlertStep {
  readonly track: AlertTrack;
  readonly event: AlertEvent | null;
}

interface Condition {
  readonly threshold: FootprintThreshold;
  readonly value: number | null;
  readonly above: boolean;
  readonly clear: boolean;
}

export const OK_TRACK: AlertTrack = {
  state: FootprintAlertState.Ok,
  streak: NO_STREAK,
  threshold: null,
};

export const FIRING_TRACK: AlertTrack = {
  state: FootprintAlertState.Firing,
  streak: NO_STREAK,
  threshold: null,
};

const RESOLVE: AlertEvent = { fire: false };

export function measuredValue(
  threshold: FootprintThreshold,
  subject: AlertSubject,
): number | null {
  switch (threshold.measure) {
    case ThresholdMeasure.Bytes:
      return subject.bytes;
    case ThresholdMeasure.FreeRatio:
      return subject.free_bytes === null ||
        subject.total_bytes === null ||
        subject.total_bytes === NO_BYTES
        ? null
        : subject.free_bytes / subject.total_bytes;
    case ThresholdMeasure.DaysToFloor:
      return subject.days_to_floor;
  }
}

export function isAbove(
  threshold: FootprintThreshold,
  value: number | null,
): boolean {
  if (value === null) return false;
  switch (threshold.measure) {
    case ThresholdMeasure.Bytes:
      return value > threshold.value;
    case ThresholdMeasure.FreeRatio:
      return value < threshold.value;
    case ThresholdMeasure.DaysToFloor:
      return value <= threshold.value;
  }
}

export function clearValue(threshold: FootprintThreshold): number {
  return threshold.measure === ThresholdMeasure.Bytes
    ? threshold.value * FOOTPRINT_ALERT_CLEAR_RATIO
    : threshold.value / FOOTPRINT_ALERT_CLEAR_RATIO;
}

export function isClear(
  threshold: FootprintThreshold,
  value: number | null,
): boolean {
  if (value === null) return true;
  const clear = clearValue(threshold);
  switch (threshold.measure) {
    case ThresholdMeasure.Bytes:
      return value <= clear;
    case ThresholdMeasure.FreeRatio:
      return value >= clear;
    case ThresholdMeasure.DaysToFloor:
      return value > clear;
  }
}

function conditionsOf(subject: AlertSubject): Condition[] {
  return subject.thresholds.map((threshold) => {
    const value = measuredValue(threshold, subject);
    return {
      threshold,
      value,
      above: isAbove(threshold, value),
      clear: isClear(threshold, value),
    };
  });
}

function fired(track: AlertTrack, above: readonly Condition[]): AlertStep {
  const first =
    above.find(
      (condition) => condition.threshold.measure === track.threshold?.measure,
    ) ?? above[0]!;
  return {
    track: {
      state: FootprintAlertState.Firing,
      streak: NO_STREAK,
      threshold: first.threshold,
    },
    event: { fire: true, threshold: first.threshold, value: first.value! },
  };
}

function pending(track: AlertTrack, above: readonly Condition[]): AlertStep {
  const streak = track.streak + FIRST_STREAK;
  const next: AlertTrack = {
    state: FootprintAlertState.Pending,
    streak,
    threshold: track.threshold ?? above[0]!.threshold,
  };
  return streak >= FOOTPRINT_ALERT_CONFIRMATIONS
    ? fired(next, above)
    : { track: next, event: null };
}

function recovering(track: AlertTrack): AlertStep {
  const streak = track.streak + FIRST_STREAK;
  return streak >= FOOTPRINT_ALERT_CONFIRMATIONS
    ? { track: OK_TRACK, event: RESOLVE }
    : {
        track: {
          state: FootprintAlertState.Recovering,
          streak,
          threshold: track.threshold,
        },
        event: null,
      };
}

export function step(track: AlertTrack, subject: AlertSubject): AlertStep {
  if (subject.stale || subject.measure_error !== null)
    return { track, event: null };
  const open =
    track.state === FootprintAlertState.Firing ||
    track.state === FootprintAlertState.Recovering;
  if (!subject.thresholds.length)
    return { track: OK_TRACK, event: open ? RESOLVE : null };
  const conditions = conditionsOf(subject);
  const above = conditions.filter((condition) => condition.above);
  const clear = conditions.every((condition) => condition.clear);
  switch (track.state) {
    case FootprintAlertState.Ok:
      return above.length
        ? pending(OK_TRACK, above)
        : { track: OK_TRACK, event: null };
    case FootprintAlertState.Pending:
      return above.length
        ? pending(track, above)
        : { track: OK_TRACK, event: null };
    case FootprintAlertState.Firing:
      return clear
        ? recovering({ ...track, streak: NO_STREAK })
        : { track, event: null };
    case FootprintAlertState.Recovering:
      return clear
        ? recovering(track)
        : {
            track: {
              ...track,
              state: FootprintAlertState.Firing,
              streak: NO_STREAK,
            },
            event: null,
          };
  }
}

export interface AcknowledgedAlert {
  readonly kind: FootprintKind;
  readonly value: number;
  readonly acknowledged_until: number | null;
}

export type AcknowledgedSubject = Pick<
  FootprintStat,
  "bytes" | "free_bytes" | "total_bytes"
>;

export function acknowledgedUntil(
  alert: AcknowledgedAlert,
  subject: AcknowledgedSubject | null,
  diskFreeRatio: number,
): number {
  if (alert.kind === FootprintKind.Disk) {
    const free = subject?.free_bytes ?? NO_BYTES;
    const floor = diskFreeRatio * (subject?.total_bytes ?? NO_BYTES);
    return free < floor
      ? Math.floor(free / HALF)
      : Math.floor(Math.max(free / HALF, floor));
  }
  return Math.floor((subject?.bytes ?? alert.value) * DOUBLE);
}

export function acknowledgementHolds(
  alert: AcknowledgedAlert,
  subject: AcknowledgedSubject | null,
): boolean {
  if (alert.acknowledged_until === null) return false;
  if (alert.kind === FootprintKind.Disk)
    return (subject?.free_bytes ?? NO_BYTES) >= alert.acknowledged_until;
  return (subject?.bytes ?? alert.value) < alert.acknowledged_until;
}
