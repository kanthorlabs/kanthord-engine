import type { Git, GitPaths } from "./index.ts";
import type { GitRunner } from "./run.ts";
import { cloneObjective } from "./clone.ts";
import { fetchTracking } from "./fetch.ts";
import { confirmHostKey, scanHostKeys, trustHostKey } from "./host-key.ts";
import { checkOutsideWriter } from "./outside-writer.ts";
import { canPush } from "./preflight.ts";
import { resolveRef } from "./ref-read.ts";
import { refUpdate } from "./ref-update.ts";
import { remoteInfo } from "./remote-info.ts";
import { seedHome } from "./seed.ts";
import { remoteUrlVerdict } from "./url.ts";

export type BinaryGitDependencies = Readonly<{
  runner: GitRunner;
  paths: GitPaths;
}>;

export function createBinaryGit(dependencies: BinaryGitDependencies): Git {
  const { runner, paths } = dependencies;
  return {
    remoteUrlVerdict: (remoteUrl) => remoteUrlVerdict(remoteUrl),
    fetch: (input) => fetchTracking(runner, paths, input),
    resolveRef: (input) => resolveRef(runner, input),
    refUpdate: (input) => refUpdate(runner, input),
    checkOutsideWriter: (input) => checkOutsideWriter(runner, input),
    clone: (input) => cloneObjective(runner, input),
    scanHostKeys: (remoteUrl) => scanHostKeys(paths, remoteUrl),
    confirmHostKey: (input) =>
      confirmHostKey(paths, input.remoteUrl, input.hostFingerprint),
    trustHostKey: (input) => trustHostKey(paths, input),
    remoteInfo: (input) => remoteInfo(runner, paths, input),
    canPush: (input) => canPush(runner, paths, input),
    seedHome: (input) => seedHome(runner, paths, input),
  };
}
