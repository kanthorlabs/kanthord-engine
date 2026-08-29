import type { Transaction } from "../storage/index.ts";
import type { ConfirmOutcome, ScanOutcome } from "./host-key.ts";
import type { CanPushInput } from "./preflight.ts";
import type { SeedHomeExtended, SeedHomeResult } from "./seed.ts";
import type { SweepHomeInput, SweepHomeReport } from "./sweep.ts";
import type { WorktreeCleanInput } from "./worktree.ts";

export type GitCredential =
  | Readonly<{
      transport: "http-basic";
      forge: string;
      username: string;
      token: string;
    }>
  | Readonly<{ transport: "ssh"; privateKey: string }>;

export type GitTransport = GitCredential["transport"];

export type HostKey = Readonly<{
  algorithm: string;
  fingerprint: string;
  publicKey: string;
}>;

export type GitPaths = Readonly<{
  git: string;
  ssh: string;
  sshKeyscan: string;
  home: string;
  keyDirectory: string;
  knownHosts: string;
  runDirectory: string;
}>;

export type SeedHomeInput = Readonly<{
  gitDir: string;
  remoteUrl: string;
  branch: string;
  credential: GitCredential;
}>;

export type RemoteInfo = Readonly<{
  defaultBranch: string | null;
  branches: readonly string[];
}>;

export type RefUpdateInput = Readonly<{
  gitDir: string;
  ref: string;
  expectedOid: string | null;
  nextOid: string;
  pidFile: string;
}>;

export type RefUpdateResult =
  | Readonly<{ updated: true; oid: string }>
  | Readonly<{ updated: false; observedOid: string | null }>;

export type CloneInput = Readonly<{
  sourceGitDir: string;
  targetDir: string;
  ref: string;
  objectiveId: string;
}>;

export type InspectChildInput = Readonly<{ pidFile: string }>;

export type ChildInspection =
  | Readonly<{ finding: "no-pid-file" }>
  | Readonly<{ finding: "pid-file-unreadable"; detail: string }>
  | Readonly<{ finding: "process-absent"; pid: number }>
  | Readonly<{
      finding: "started-later";
      pid: number;
      startedAt: number;
      recordedAt: number;
    }>
  | Readonly<{ finding: "liveness-unknown"; pid: number; detail: string }>
  | Readonly<{ finding: "alive"; pid: number; pidFile: string }>;

export type StopChildInput = Readonly<{
  pid: number;
  graceMs: number;
  pollMs?: number;
}>;

export type GitFailure =
  | "auth-failed"
  | "permission-denied"
  | "transport-failed"
  | "host-key-mismatch"
  | "host-key-unavailable"
  | "url-refused"
  | "lock-held"
  | "timed-out"
  | "output-exceeded"
  | "unknown"
  | "empty-remote";

export type ForgeConvention = Readonly<{ username: string | null }>;

export const forgeConventions: Readonly<Record<string, ForgeConvention>> = {
  github: { username: null },
  gitlab: { username: "oauth2" },
  bitbucket: { username: "x-token-auth" },
};

export class GitError extends Error {
  readonly failure: GitFailure;
  readonly detail: string;
  constructor(failure: GitFailure, message: string, detail = "") {
    super(message);
    this.name = "GitError";
    this.failure = failure;
    this.detail = detail;
  }
}

export type UrlRefusal =
  | "malformed"
  | "scheme-not-allowed"
  | "insecure-non-loopback"
  | "password-in-url"
  | "option-like"
  | "control-character";

export type RemoteUrlVerdict =
  | Readonly<{ allowed: true; transport: GitTransport; host: string }>
  | Readonly<{ allowed: false; refusal: UrlRefusal; reason: string }>;

export type PushPreflight =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; failure: GitFailure; detail: string }>;

export type ProbePushInput = Readonly<{
  remoteUrl: string;
  branch: string | null;
  credential: GitCredential;
}>;

export type OutsideWriterInput = Readonly<{
  transaction: Transaction;
  gitDir: string;
  repositoryId: string;
  ref: string;
  intent: "merge" | "sync" | "publish" | "revert";
}>;

export type OutsideWriterVerdict =
  | Readonly<{ expected: true; oid: string | null }>
  | Readonly<{
      expected: false;
      expectedOid: string | null;
      observedOid: string | null;
    }>;

export interface Git {
  remoteUrlVerdict(remoteUrl: string): RemoteUrlVerdict;
  scanHostKeys(remoteUrl: string): Promise<ScanOutcome>;
  confirmHostKey(
    input: Readonly<{ remoteUrl: string; hostFingerprint: string }>,
  ): Promise<ConfirmOutcome>;
  trustHostKey(
    input: Readonly<{ remoteUrl: string; hostKey: HostKey }>,
  ): Promise<void>;
  seedHome(input: SeedHomeExtended): Promise<SeedHomeResult>;
  remoteInfo(
    input: Readonly<{ remoteUrl: string; credential: GitCredential }>,
  ): Promise<RemoteInfo>;
  canPush(input: CanPushInput): Promise<PushPreflight>;
  probePush(input: ProbePushInput): Promise<PushPreflight>;
  fetch(
    input: Readonly<{
      gitDir: string;
      credential: GitCredential;
      pidFile: string;
    }>,
  ): Promise<void>;
  resolveRef(
    input: Readonly<{ gitDir: string; ref: string }>,
  ): Promise<string | null>;
  refUpdate(input: RefUpdateInput): Promise<RefUpdateResult>;
  checkOutsideWriter(input: OutsideWriterInput): Promise<OutsideWriterVerdict>;
  clone(input: CloneInput): Promise<string>;
  inspectChild(input: InspectChildInput): Promise<ChildInspection>;
  stopChild(input: StopChildInput): Promise<boolean>;
  listPidFiles(
    input: Readonly<{ runDirectory: string }>,
  ): Promise<readonly string[]>;
  removePidFile(input: Readonly<{ pidFile: string }>): Promise<void>;
  sweepHome(input: SweepHomeInput): Promise<SweepHomeReport>;
  worktreeClean(input: WorktreeCleanInput): Promise<boolean>;
}

export const TRACKING_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

export type GitIntent = "merge" | "sync" | "publish" | "revert";

export type OpenJournalRowInput = Readonly<{
  id: string;
  repositoryId: string;
  intent: GitIntent;
  nodeId: string | null;
  runId: string | null;
  candidateId: string | null;
  leaseFence: number;
  ref: string;
  baseOid: string;
  proposedHeadOid: string;
  expectedRemoteOid: string | null;
  childToken: string;
}>;

export type CompleteJournalRowInput = Readonly<{
  id: string;
  resultHeadOid: string | null;
  outcome: string | null;
  completedAt: number;
}>;

export type DiscardJournalRowInput = Readonly<{
  id: string;
  outcome: string | null;
  completedAt: number;
}>;

export type InFlightJournalRow = Readonly<{
  id: string;
  repositoryId: string;
  repositoryHomePath: string;
  intent: GitIntent;
  ref: string;
  baseOid: string;
  proposedHeadOid: string;
  childToken: string;
}>;

export type OpenJournalRow = Readonly<{
  id: string;
  repositoryId: string;
  repositoryHomePath: string;
  intent: GitIntent;
  ref: string;
  baseOid: string;
  proposedHeadOid: string;
  childToken: string | null;
}>;

export type JournalErrorCode = "journal-row-not-open";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

export interface GitJournal {
  open(transaction: Transaction, input: OpenJournalRowInput): void;
  complete(
    transaction: Transaction,
    input: CompleteJournalRowInput,
  ): string | null;
  discard(
    transaction: Transaction,
    input: DiscardJournalRowInput,
  ): string | null;
  listInFlight(transaction: Transaction): readonly InFlightJournalRow[];
  listOpen(transaction: Transaction): readonly OpenJournalRow[];
  markPublishPending(
    transaction: Transaction,
    input: Readonly<{ id: string; outcome: string }>,
  ): string | null;
  clearChildToken(
    transaction: Transaction,
    input: Readonly<{ id: string }>,
  ): string | null;
}
