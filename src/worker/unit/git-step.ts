export const GitStep = {
  Commit: "commit",
  FetchBase: "fetch_base",
  MergeBase: "merge_base",
  Push: "push",
} as const;
export type GitStep = (typeof GitStep)[keyof typeof GitStep];

const OBJECT_TYPE = "object";
const marks = new WeakMap<object, GitStep>();

function isObject(value: unknown): value is object {
  return value !== null && typeof value === OBJECT_TYPE;
}

export function markGitStep(error: unknown, step: GitStep): void {
  if (!isObject(error) || marks.has(error)) return;
  marks.set(error, step);
}

export function gitStepOf(error: unknown): GitStep | null {
  return isObject(error) ? (marks.get(error) ?? null) : null;
}
