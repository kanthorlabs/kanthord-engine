import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSshRemote } from "./index.ts";
import type { SshRemote } from "./ssh.ts";
import {
  fixtureObjectIds,
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
} from "./seed.ts";
import { resolveTools, toolTimeoutMilliseconds } from "./tools.ts";
import type { Tools } from "./tools.ts";

const execGit = promisify(execFile);

const spawnGuard = {
  timeout: toolTimeoutMilliseconds,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

const pastOldDaemonSpawnDeadlineMilliseconds = toolTimeoutMilliseconds + 1000;

async function authenticatedFetch(
  tools: Tools,
  remote: SshRemote,
): Promise<string> {
  const knownHosts = remote.writeKnownHosts(remote.hostKeys);
  const env = {
    ...pinnedGitEnvironment,
    PATH: tools.execPath,
    GIT_SSH_COMMAND: remote.sshCommand({ knownHosts }),
  };
  const { stdout } = await execGit(
    tools.paths.git,
    [...pinnedGitConfigArguments, "ls-remote", remote.url("fixture.git")],
    { env, encoding: "utf8", ...spawnGuard },
  );
  return stdout.toString();
}

describe("test/helpers/remote/ssh-longevity.test", () => {
  it("keeps serving an authenticated fetch past the old 10 second daemon spawn deadline", async () => {
    const tools = resolveTools({});
    const remote = await createSshRemote();
    after(() => remote.dispose());

    const commit2 = fixtureObjectIds.commit2;
    assert.ok(commit2 !== undefined);
    const expectedLine = `${commit2}\trefs/heads/main`;

    const early = await authenticatedFetch(tools, remote);
    assert.ok(
      early.includes(expectedLine),
      "the fixture did not answer an authenticated fetch at t≈0",
    );

    await new Promise((resolve) =>
      setTimeout(resolve, pastOldDaemonSpawnDeadlineMilliseconds),
    );

    const late = await authenticatedFetch(tools, remote);
    assert.ok(
      late.includes(expectedLine),
      "the fixture no longer answered an authenticated fetch past the old 10 second daemon spawn deadline",
    );
  });
});
