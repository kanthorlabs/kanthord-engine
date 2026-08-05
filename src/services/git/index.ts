import type { Transaction } from "../storage/index.ts";
import type { ConfirmOutcome, ScanOutcome } from "./host-key.ts";
import type { CanPushInput } from "./preflight.ts";
import type { SeedHomeExtended, SeedHomeResult } from "./seed.ts";

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
  upstreamBranch: string;
  landingBranch: string;
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
  | "unknown";

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
}

export const TRACKING_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
