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
  resolveBranchCommit,
  readFilesAtCommit,
} from "./connector.ts";
import type { SshIdentity, SshPin } from "./ssh-identity.ts";
import { proveSshPin } from "./credential-platform.ts";
export {
  RepositoryCredentials,
  type CredentialDependencies,
} from "./credential.ts";
export { REPOSITORY_PLATFORMS } from "./credential-platform.ts";

export const repositoryFiles = { resolveBranchCommit, readFilesAtCommit };

export interface Dependencies {
  health?: HealthRegistry;
}

export class RepositoryComponent {
  clone = clone;
  cloneSnapshot = cloneSnapshot;
  fetchAndCheckout = fetchAndCheckout;
  pushNodeBranch = pushNodeBranch;
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
