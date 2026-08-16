export const ZERO_OID = "0000000000000000000000000000000000000000";

export type RecoveryFinding = Readonly<{
  step: "reap" | "sweep" | "reconcile" | "leases";
  code: string;
  repositoryId: string | null;
  detail: string;
}>;

export type RecoveryErrorCode =
  | "orphan-alive"
  | "liveness-unknown"
  | "ref-unreadable"
  | "platform-unsupported";

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  constructor(code: RecoveryErrorCode, message: string) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
  }
}

export function renderFinding(finding: RecoveryFinding): string {
  if (finding.repositoryId === null) {
    return `${finding.step}: ${finding.code}: ${finding.detail}`;
  }
  return `${finding.step}: ${finding.code}: ${finding.repositoryId}: ${finding.detail}`;
}

export const SEED_PID_PATTERN = /^seed-(repo_[0-9A-HJKMNP-TV-Z]{26})\.pid$/;

export const GITOP_PID_PATTERN = /^gitop-(gitop_[0-9A-HJKMNP-TV-Z]{26})\.pid$/;

export type ReapedChild = Readonly<{
  pidFile: string;
  gitOperationId: string | null;
  repositoryId: string | null;
  finding:
    | "no-pid-file"
    | "pid-file-unreadable"
    | "process-absent"
    | "started-later"
    | "stopped";
}>;

export type ReapReport = Readonly<{
  children: readonly ReapedChild[];
  findings: readonly RecoveryFinding[];
}>;

export type ReapStep = () => Promise<ReapReport>;

export type SweepStep = (reap: ReapReport) => Promise<SweepRemnantsResultLike>;

export type ReconcileStep = () => Promise<ReconcileResultLike>;

export type LeasesStep = () => Promise<LeasesResultLike>;

export type SweepRemnantsResultLike = Readonly<{
  removed: number;
  findings: readonly RecoveryFinding[];
}>;

export type ReconcileResultLike = Readonly<{
  completed: number;
  discarded: number;
  leftOpen: number;
  refusesNewWork: readonly string[];
  findings: readonly RecoveryFinding[];
}>;

export type LeasesResultLike = Readonly<{
  returnedToReady: number;
  objectivesFreed: number;
  blocked: number;
  findings: readonly RecoveryFinding[];
}>;

export const RECOVERY_STEP_ORDER = [
  "reap",
  "sweep",
  "reconcile",
  "leases",
] as const;

export type RecoveryReport = Readonly<{
  reaped: number;
  removed: number;
  completed: number;
  discarded: number;
  leftOpen: number;
  refusesNewWork: readonly string[];
  returnedToReady: number;
  objectivesFreed: number;
  blocked: number;
  findings: readonly RecoveryFinding[];
}>;
