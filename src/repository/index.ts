import { background, type Context } from "../kernel/context.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus, type Healthcheck } from "../kernel/service.ts";
import { checkRepositoryTools, probeRepositoryTools } from "./check.ts";
import {
  gitLsRemote,
  resolveSshHostname,
  resolveSshIdentity,
  clone,
  cloneSnapshot,
  fetchAndCheckout,
  pushNodeBranch,
  mergePushFresh,
  pushSnapshotFresh,
  landedOn,
} from "./connector.ts";
import type { SshIdentity, SshPin } from "./ssh-identity.ts";
import { proveSshPin } from "./credential-platform.ts";
import { GitHubPlatform } from "./github.ts";
import { RepositoryPlatform } from "../project/contract.ts";
export {
  RepositoryCredentials,
  type CredentialDependencies,
} from "./credential.ts";
export { REPOSITORY_PLATFORMS } from "./credential-platform.ts";
export { decodeGitHubEvent } from "./github.ts";
export {
  foldBranchPush,
  GitStage,
  GitWriteError,
  type BranchCommitInput,
  type Landing,
  type MergePushInput,
} from "./connector.ts";

export interface GitWriter {
  mergePushFresh: typeof mergePushFresh;
  pushSnapshotFresh: typeof pushSnapshotFresh;
  landedOn: typeof landedOn;
}

export const platformImplementations = {
  [RepositoryPlatform.GitHub]: GitHubPlatform,
} as const;

export interface Dependencies {
  health?: HealthRegistry;
}

export class RepositoryComponent implements GitWriter {
  clone = clone;
  cloneSnapshot = cloneSnapshot;
  fetchAndCheckout = fetchAndCheckout;
  pushNodeBranch = pushNodeBranch;
  mergePushFresh = mergePushFresh;
  pushSnapshotFresh = pushSnapshotFresh;
  landedOn = landedOn;
  constructor(dependencies: Dependencies = {}) {
    checkRepositoryTools();
    dependencies.health?.register("repository", (context) =>
      this.healthcheck(context),
    );
  }

  async healthcheck(context: Context = background): Promise<Healthcheck> {
    const available = await probeRepositoryTools(context);
    return {
      toolchain: available ? HealthStatus.Healthy : HealthStatus.Unavailable,
    };
  }

  resolveSshHostname(
    host: string,
    context: Context,
    deadlineMs: number,
  ): Promise<string> {
    return resolveSshHostname(host, context, deadlineMs);
  }

  proveSshIdentity(
    pin: SshPin,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    return proveSshPin(pin, context, deadlineMs);
  }

  resolveSshIdentity(
    host: string,
    context: Context,
    deadlineMs: number,
  ): Promise<SshIdentity> {
    return resolveSshIdentity(host, context, deadlineMs);
  }

  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    return gitLsRemote(sshUrl, context, deadlineMs);
  }
}
