import { background, type Context } from "../kernel/context.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus, type Healthcheck } from "../kernel/service.ts";
import { checkRepositoryTools, probeRepositoryTools } from "./check.ts";
import {
  gitLsRemote,
  resolveSshHostname,
  clone,
  cloneSnapshot,
  fetchAndCheckout,
  pushNodeBranch,
} from "./connector.ts";

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

  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    return gitLsRemote(sshUrl, context, deadlineMs);
  }
}
