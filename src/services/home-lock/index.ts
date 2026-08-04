export type FilesystemKind = "local" | "network" | "unknown";

export interface FilesystemProbe {
  classify(path: string): FilesystemKind;
}

export type HomeIdentity = Readonly<{
  version: 1;
  pid: number;
  host: string;
  startedAt: string;
  instanceId: string;
}>;

export interface HeldHome {
  readonly path: string;
  publishIdentity(identity: HomeIdentity): void;
  release(): void;
}

export type AcquireInput = Readonly<{
  home: string;
  identityWaitMs?: number;
  identityPollMs?: number;
  beforeRetry?: () => void;
}>;

export type HomeLockErrorCode =
  "home-network-filesystem" | "home-lock-corrupt" | "home-locked";

export class HomeLockError extends Error {
  readonly code: HomeLockErrorCode;
  readonly holder: HomeIdentity | null;
  constructor(
    code: HomeLockErrorCode,
    message: string,
    holder: HomeIdentity | null = null,
  ) {
    super(message);
    this.name = "HomeLockError";
    this.code = code;
    this.holder = holder;
  }
}

export interface HomeLock {
  acquire(input: AcquireInput): HeldHome;
}
