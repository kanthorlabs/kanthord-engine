import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { createHttpRemote } from "../../../test/helpers/remote/index.ts";
import type { HttpRemote } from "../../../test/helpers/remote/index.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";

import { GitError, type GitCredential, type GitPaths } from "./index.ts";
import { buildGitPaths } from "./probe.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunRequest, GitRunner } from "./run.ts";
import { probePush } from "./push-probe.ts";
import type { ProbedTools } from "./probe.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

let httpRemote: HttpRemote;
let paths: GitPaths;
let runner: GitRunner;

before(async () => {
  httpRemote = await createHttpRemote();
  const base = mkdtempSync(join(tmpdir(), "kanthord-push-probe-test-"));
  directories.push(base);
  const probed: ProbedTools = {
    git: tools.paths.git,
    ssh: tools.paths.ssh,
    sshKeyscan: tools.paths.sshKeyscan,
    gitVersion: tools.gitVersion,
    sshVersion: tools.sshVersion,
  };
  paths = buildGitPaths({ probed, home: base });
  runner = createGitRunner(paths);
});

after(async () => {
  await httpRemote?.dispose();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function httpBasic(username: string, token: string): GitCredential {
  return {
    transport: "http-basic",
    forge: "github",
    username,
    token,
  };
}

function writerCredential(): GitCredential {
  return httpBasic(
    httpRemote.credentials.writer.username,
    httpRemote.credentials.writer.token,
  );
}

function readerCredential(): GitCredential {
  return httpBasic(
    httpRemote.credentials.reader.username,
    httpRemote.credentials.reader.token,
  );
}

function fixtureUrl(): string {
  return httpRemote.url("fixture.git");
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (!isAbsolute(fromParent) &&
      fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`))
  );
}

function assertProbePathsOutsideConfiguredHome(tempDir: string): void {
  for (const createdPath of [
    tempDir,
    join(tempDir, "keys"),
    join(tempDir, "run"),
    join(tempDir, "fetch.pid"),
  ]) {
    assert.equal(pathIsWithin(paths.home, createdPath), false, createdPath);
  }
}

function assertConfiguredKeyDirectoryEmpty(): void {
  assert.deepEqual(readdirSync(paths.keyDirectory), []);
}

function trackingRunner(realRunner: GitRunner): {
  runner: GitRunner;
  requests: GitRunRequest[];
  tempDir(): string | undefined;
} {
  const requests: GitRunRequest[] = [];
  let capturedTempDir: string | undefined;
  const wrapped: GitRunner = async (request) => {
    requests.push(request);
    if (request.args[0] === "init") {
      capturedTempDir = request.args.at(-1);
    }
    return realRunner(request);
  };
  return {
    runner: wrapped,
    requests,
    tempDir: () => capturedTempDir,
  };
}

function capturedTempDir(value: string | undefined): string {
  assert.ok(value !== undefined, "the probe init command was not recorded");
  return value;
}

describe("src/services/git/push-probe.ts", () => {
  it("branch null returns empty-remote without creating a temp directory", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "kanthord-empty-remote-root-"),
    );
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedRoot;
    let calls = 0;
    const noCallRunner: GitRunner = async () => {
      calls += 1;
      throw new Error("runner must not be called for an empty remote");
    };

    try {
      const result = await probePush(noCallRunner, paths, {
        remoteUrl: fixtureUrl(),
        branch: null,
        credential: writerCredential(),
      });

      assert.deepEqual(result, {
        allowed: false,
        failure: "empty-remote",
        detail: "",
      });
      assert.equal(calls, 0);
      assert.deepEqual(readdirSync(isolatedRoot), []);
      assertConfiguredKeyDirectoryEmpty();
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("writer credential may push — temp dir is removed after success", async () => {
    const tracked = trackingRunner(runner);
    const result = await probePush(tracked.runner, paths, {
      remoteUrl: fixtureUrl(),
      branch: "main",
      credential: writerCredential(),
    });
    const tempDir = capturedTempDir(tracked.tempDir());

    assert.deepEqual(result, { allowed: true });
    assert.equal(existsSync(tempDir), false);
    assert.ok(tempDir.startsWith(tmpdir()));
    assertProbePathsOutsideConfiguredHome(tempDir);
    assertConfiguredKeyDirectoryEmpty();
  });

  it("reader credential push advertisement returns auth-failed verdict — temp dir is removed", async () => {
    const tracked = trackingRunner(runner);
    const result = await probePush(tracked.runner, paths, {
      remoteUrl: fixtureUrl(),
      branch: "main",
      credential: readerCredential(),
    });
    const tempDir = capturedTempDir(tracked.tempDir());

    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.failure, "auth-failed");
    }
    assert.equal(existsSync(tempDir), false);
    assertProbePathsOutsideConfiguredHome(tempDir);
    assertConfiguredKeyDirectoryEmpty();
  });

  it("thrown GitError during fetch — temp dir is removed", async () => {
    let tempDir: string | undefined;
    const throwingRunner: GitRunner = async (request) => {
      if (request.args[0] === "init") {
        tempDir = request.args.at(-1);
      }
      if (request.args.includes("fetch")) {
        throw new GitError("transport-failed", "simulated fetch failure", "");
      }
      return {
        code: 0,
        stdout: "",
        stderr: "",
        args: request.args,
      };
    };

    await assert.rejects(
      probePush(throwingRunner, paths, {
        remoteUrl: fixtureUrl(),
        branch: "main",
        credential: writerCredential(),
      }),
      (error: unknown) =>
        error instanceof GitError && error.failure === "transport-failed",
    );

    const captured = capturedTempDir(tempDir);
    assert.equal(existsSync(captured), false);
    assertProbePathsOutsideConfiguredHome(captured);
    assertConfiguredKeyDirectoryEmpty();
  });

  it("probe uses probe-local keyDirectory, not paths.keyDirectory", async () => {
    const tracked = trackingRunner(runner);
    await probePush(tracked.runner, paths, {
      remoteUrl: fixtureUrl(),
      branch: "main",
      credential: writerCredential(),
    });
    const tempDir = capturedTempDir(tracked.tempDir());
    const requests = JSON.stringify(tracked.requests);

    assert.equal(requests.includes(paths.keyDirectory), false);
    assert.equal(requests.includes(tempDir), true);
  });
});
