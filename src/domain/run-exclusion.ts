export type ExclusionRun = Readonly<{
  runId: string;
  nodeId: string;
  state: "active" | "ended";
  expiresAt: number | null;
}>;

export type SubtreeExclusionInput = Readonly<{
  targetId: string;
  ancestorIds: readonly string[];
  descendantIds: readonly string[];
  runs: readonly ExclusionRun[];
  now: number;
}>;

export type SubtreeExclusionRefusal = Readonly<{
  refusal: "subtree-busy";
  relation: "self" | "ancestor" | "descendant";
  nodeId: string;
  runId: string;
  expiresAt: number | null;
}>;

const encoder = new TextEncoder();

function compareBytewise(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {
      return difference;
    }
  }

  return leftBytes.length - rightBytes.length;
}

function isLive(run: ExclusionRun, now: number): boolean {
  return (
    run.state === "active" && (run.expiresAt === null || run.expiresAt > now)
  );
}

function firstMatch(
  runs: readonly ExclusionRun[],
  matches: (nodeId: string) => boolean,
): ExclusionRun | null {
  let selected: ExclusionRun | null = null;

  for (const run of runs) {
    if (!matches(run.nodeId)) {
      continue;
    }
    if (
      selected === null ||
      compareBytewise(run.nodeId, selected.nodeId) < 0 ||
      (run.nodeId === selected.nodeId &&
        compareBytewise(run.runId, selected.runId) < 0)
    ) {
      selected = run;
    }
  }

  return selected;
}

function refusal(
  relation: SubtreeExclusionRefusal["relation"],
  run: ExclusionRun,
): SubtreeExclusionRefusal {
  return {
    refusal: "subtree-busy",
    relation,
    nodeId: run.nodeId,
    runId: run.runId,
    expiresAt: run.expiresAt,
  };
}

export function subtreeExclusion(
  input: SubtreeExclusionInput,
): SubtreeExclusionRefusal | null {
  const liveRuns = input.runs.filter((run) => isLive(run, input.now));

  const self = firstMatch(liveRuns, (nodeId) => nodeId === input.targetId);
  if (self !== null) {
    return refusal("self", self);
  }

  const ancestorIds = new Set(input.ancestorIds);
  const ancestor = firstMatch(liveRuns, (nodeId) => ancestorIds.has(nodeId));
  if (ancestor !== null) {
    return refusal("ancestor", ancestor);
  }

  const descendantIds = new Set(input.descendantIds);
  const descendant = firstMatch(liveRuns, (nodeId) =>
    descendantIds.has(nodeId),
  );
  if (descendant !== null) {
    return refusal("descendant", descendant);
  }

  return null;
}

export type ObjectiveBusyInput = Readonly<{
  objectiveId: string;
  siblingRuns: readonly ExclusionRun[];
  now: number;
}>;

export type ObjectiveBusyRefusal = Readonly<{
  refusal: "objective-busy";
  objectiveId: string;
  siblingNodeId: string;
  siblingRunId: string;
  expiresAt: number | null;
}>;

export function objectiveBusy(
  input: ObjectiveBusyInput,
): ObjectiveBusyRefusal | null {
  const liveRuns = input.siblingRuns.filter((run) => isLive(run, input.now));
  let selected: ExclusionRun | null = null;

  for (const run of liveRuns) {
    if (
      selected === null ||
      compareBytewise(run.nodeId, selected.nodeId) < 0 ||
      (run.nodeId === selected.nodeId &&
        compareBytewise(run.runId, selected.runId) < 0)
    ) {
      selected = run;
    }
  }

  if (selected === null) {
    return null;
  }

  return {
    refusal: "objective-busy",
    objectiveId: input.objectiveId,
    siblingNodeId: selected.nodeId,
    siblingRunId: selected.runId,
    expiresAt: selected.expiresAt,
  };
}
