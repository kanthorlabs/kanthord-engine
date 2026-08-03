export type GitAuth = Readonly<{ username: string; password: string }>;

export type SeedHomeInput = Readonly<{
  gitDir: string;
  remoteUrl: string;
  upstreamBranch: string;
  landingBranch: string;
  auth: GitAuth;
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
}>;

export type RefUpdateResult =
  | Readonly<{ updated: true; oid: string }>
  | Readonly<{ updated: false; observedOid: string | null }>;

export type CloneInput = Readonly<{
  sourceGitDir: string;
  targetDir: string;
  ref: string;
}>;

export type GitErrorCode =
  "git-auth-failed" | "git-url-refused" | "git-lock-held" | "git-ref-missing";

export class GitError extends Error {
  readonly code: GitErrorCode;
  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

export interface Git {
  seedHome(input: SeedHomeInput): Promise<void>;
  remoteInfo(
    input: Readonly<{ remoteUrl: string; auth: GitAuth }>,
  ): Promise<RemoteInfo>;
  canPush(
    input: Readonly<{ remoteUrl: string; auth: GitAuth }>,
  ): Promise<boolean>;
  fetch(input: Readonly<{ gitDir: string; auth: GitAuth }>): Promise<void>;
  resolveRef(input: Readonly<{ gitDir: string; ref: string }>): Promise<string>;
  refUpdate(input: RefUpdateInput): Promise<RefUpdateResult>;
  clone(input: CloneInput): Promise<string>;
}
