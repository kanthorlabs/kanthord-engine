import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { fixtureObjectIds } from "../../../test/helpers/remote/index.ts";

import {
  TRACKING_REFSPEC,
  type Git,
  type GitCredential,
  type GitPaths,
} from "./index.ts";
import type { GitRunRequest, GitRunner } from "./run.ts";
import { createBinaryGit } from "./binary.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-binary-"));
  directories.push(dir);
  const home = join(dir, "home");
  const keyDirectory = join(dir, "keys");
  const knownHosts = join(dir, "known_hosts");
  const runDirectory = join(dir, "run");
  for (const sub of [home, keyDirectory, runDirectory]) {
    mkdirSync(sub);
  }
  writeFileSync(knownHosts, "");
  return {
    git: tools.paths.git,
    ssh: tools.paths.ssh,
    sshKeyscan: tools.paths.sshKeyscan,
    home,
    keyDirectory,
    knownHosts,
    runDirectory,
  };
}

function httpBasic(username: string, token: string): GitCredential {
  return {
    transport: "http-basic",
    forge: "github",
    username,
    token,
  };
}

const oid: string = fixtureObjectIds.commit2!;

function recordingRunner(): {
  runner: GitRunner;
  requests: GitRunRequest[];
} {
  const requests: GitRunRequest[] = [];
  const runner: GitRunner = async (request) => {
    requests.push(request);
    const isRevParse = request.args.includes("rev-parse");
    return {
      code: 0,
      stdout: isRevParse ? oid + "\n" : "",
      stderr: "",
      args: request.args,
    };
  };
  return { runner, requests };
}

describe("src/services/git/binary.test", () => {
  it("Object.keys of createBinaryGit bytewise sorted deep-equals the nineteen member names", () => {
    const paths = makePaths();
    const { runner } = recordingRunner();
    const git = createBinaryGit({ runner, paths });
    const keys = Object.keys(git).sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    assert.equal(keys.length, 19);
    assert.deepEqual(keys, [
      "canPush",
      "checkOutsideWriter",
      "clone",
      "confirmHostKey",
      "fetch",
      "inspectChild",
      "listPidFiles",
      "probePush",
      "refUpdate",
      "remoteInfo",
      "remoteUrlVerdict",
      "removePidFile",
      "resolveRef",
      "scanHostKeys",
      "seedHome",
      "stopChild",
      "sweepHome",
      "trustHostKey",
      "worktreeClean",
    ]);
  });

  it("every member is a function, and createBinaryGit returns a new object each call", () => {
    const paths = makePaths();
    const { runner } = recordingRunner();
    const first = createBinaryGit({ runner, paths });
    const second = createBinaryGit({ runner, paths });
    assert.notEqual(first, second);
    for (const name of Object.keys(first)) {
      assert.equal(typeof first[name as keyof Git], "function", name);
    }
  });

  describe("each member delegates to its module", () => {
    it("remoteUrlVerdict records nothing", () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      git.remoteUrlVerdict("https://forge.test/r.git");
      assert.equal(requests.length, 0);
    });

    it("fetch records the fetch command", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      await git.fetch({
        gitDir: "/tmp/x.git",
        credential: httpBasic("writer", "w-tok"),
        pidFile: join(paths.runDirectory, "fetch.pid"),
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.args.includes("fetch"), true);
    });

    it("resolveRef records rev-parse", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      const value = await git.resolveRef({
        gitDir: "/tmp/x.git",
        ref: "refs/heads/main",
      });
      assert.equal(value, oid);
      assert.equal(requests[0]!.args.includes("rev-parse"), true);
    });

    it("refUpdate records update-ref", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      const result = await git.refUpdate({
        gitDir: "/tmp/x.git",
        ref: "refs/heads/main",
        expectedOid: null,
        nextOid: oid,
        pidFile: join(paths.runDirectory, "update.pid"),
      });
      assert.deepEqual(result, { updated: true, oid });
      assert.equal(requests[0]!.args.includes("update-ref"), true);
    });

    it("clone records clone", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      const targetDir = join(dirname(paths.home), "target");
      const rejection = await git
        .clone({
          sourceGitDir: "/tmp/src.git",
          targetDir,
          ref: "land",
          objectiveId: "objective_01JQ8Z4A2B",
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.ok(rejection !== null, "the clone rejects on a recording runner");
      assert.equal(requests[0]!.args[0], "clone");
    });

    it("remoteInfo records ls-remote", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      const info = await git.remoteInfo({
        remoteUrl: "https://forge.test/r.git",
        credential: httpBasic("writer", "w-tok"),
      });
      assert.deepEqual(info, { defaultBranch: null, branches: [] });
      assert.ok(
        requests.every((request) => request.args.includes("ls-remote")),
      );
    });

    it("canPush records push", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      const verdict = await git.canPush({
        gitDir: "/tmp/x.git",
        remoteUrl: "https://forge.test/r.git",
        publishRef: "refs/heads/main",
        proposedOid: oid,
        credential: httpBasic("writer", "w-tok"),
      });
      assert.deepEqual(verdict, { allowed: true });
      assert.equal(requests[0]!.args.includes("push"), true);
    });

    it("probePush records fetch with the tracking refspec", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      const verdict = await git.probePush({
        remoteUrl: "https://forge.test/r.git",
        branch: "main",
        credential: httpBasic("writer", "w-tok"),
      });
      assert.deepEqual(verdict, { allowed: true });
      assert.equal(
        requests.some(
          (request) =>
            request.args.includes("fetch") &&
            request.args.includes(TRACKING_REFSPEC),
        ),
        true,
      );
    });

    it("scanHostKeys records no git call at all", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner();
      const git = createBinaryGit({ runner, paths });
      const outcome = await git.scanHostKeys("ssh://git@127.0.0.1:1/r.git");
      assert.equal(outcome.scanned, false);
      assert.equal(requests.length, 0);
    });
  });

  it("createBinaryGit type-checks as Git", () => {
    const paths = makePaths();
    const { runner } = recordingRunner();
    const git: Git = createBinaryGit({ runner, paths });
    assert.equal(typeof git.seedHome, "function");
  });
});
