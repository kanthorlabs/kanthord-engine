export type OutcomeState = "replayable" | "indeterminate" | "uncacheable";

export type ClassifyInput = Readonly<{
  replayable: readonly number[] | undefined;
  status: number;
  internal: boolean;
}>;

export function classifyOutcome(input: ClassifyInput): OutcomeState {
  if (input.internal) {
    return "indeterminate";
  }
  if (
    input.replayable !== undefined &&
    input.replayable.includes(input.status)
  ) {
    return "replayable";
  }
  return "uncacheable";
}
