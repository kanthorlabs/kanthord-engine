export const TurnViolation = {
  BranchChanged: "worker.turn.branch_changed",
  HistoryRewritten: "worker.turn.history_rewritten",
  GitInProgress: "worker.turn.git_in_progress",
  MergeMissing: "worker.turn.merge_missing",
} as const;
export type TurnViolation = (typeof TurnViolation)[keyof typeof TurnViolation];
export const MERGE_MARKERS_LEFT = "worker.merge.markers_left";
export const VERIFICATION_INFRASTRUCTURE_FAILED =
  "worker.verification.infrastructure_failed";
export const GIT_COMMIT_FAILED = "worker.git.commit_failed";
