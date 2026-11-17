import { join } from "node:path";
import { DeadlineKind } from "./chain.ts";
import { hostInputOf, type Step } from "./chain-host.ts";
import { BaseHead, namedCheckouts, setupEntries } from "./environment-setup.ts";
import type { ImplementPorts } from "./foundry-ports.ts";
import { repositoryOf } from "./setup-repository.ts";
import { SETUP_STOP, setupInputOf } from "./step-setup-entries.ts";
import { next } from "./step-support.ts";
import { BASE_DIRECTORY } from "./workspace-layout.ts";

export const setupEntriesLive: Step<
  unknown,
  "claim" | "setup" | "sshAccess" | "workspace",
  "setupEntries" | "baseHead",
  ImplementPorts
> = {
  id: "setup.entries(live)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "sshAccess", "workspace"],
  writes: ["setupEntries", "baseHead"],
  stops: [SETUP_STOP],
  async run(ctx, scope, io) {
    const input = hostInputOf(ctx, io);
    const setupInput = setupInputOf(ctx, { ...io, env: io.host.env });
    const entries = await setupEntries(
      setupInput,
      ctx.workspace.checkouts.map((checkout) => ({
        repository: repositoryOf({ input }, checkout),
        directory: checkout.directory,
      })),
    );
    const baseHead = new BaseHead(
      setupInput,
      { trees: { port: io.ports.releaseTrees, log: io.ports.log } },
      entries,
    );
    io.resources.defer(() => baseHead.giveBack());
    return next(scope, { setupEntries: entries, baseHead });
  },
};

export const setupEntriesReview: Step<
  unknown,
  "claim" | "setup" | "reviewWorkspace",
  "setupEntries" | "baseHead"
> = {
  id: "setup.entries(review)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "reviewWorkspace"],
  writes: ["setupEntries", "baseHead"],
  stops: [SETUP_STOP],
  async run(ctx, scope, io) {
    const workspace = ctx.reviewWorkspace;
    if (!workspace.checkouts.length)
      return next(scope, { setupEntries: [], baseHead: null });
    const setupInput = setupInputOf(ctx, { ...io, env: io.host.env });
    const entries = await setupEntries(
      setupInput,
      namedCheckouts(ctx.setup.repositories, workspace.checkouts),
    );
    const baseHead = new BaseHead(
      setupInput,
      { directory: join(workspace.key, BASE_DIRECTORY) },
      entries,
    );
    return next(scope, { setupEntries: entries, baseHead });
  },
};
