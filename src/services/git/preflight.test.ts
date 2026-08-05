import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { createHttpRemote } from "../../../test/helpers/remote/index.ts";
import type { HttpRemote } from "../../../test/helpers/remote/index.ts";

import {
  GitError,
  TRACKING_REFSPEC,
  type GitCredential,
  type GitPaths,
} from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunRequest, GitRunner } from "./run.ts";
import { HELPER_FILE_NAME, classifyFailure } from "./credential.ts";
import { runAuthenticated } from "./authenticated.ts";
import { fetchTracking } from "./fetch.ts";
import { canPush, remoteRefValue } from "./preflight.ts";
import type { CanPushInput } from "./preflight.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

let httpRemote: HttpRemote;

before(async () => {
  httpRemote = await createHttpRemote();
});

after(async () => {
  await httpRemote?.dispose();
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-preflight-"));
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

function wrongCredential(): GitCredential {
  return httpBasic(
    httpRemote.wrongCredential.username,
    httpRemote.wrongCredential.token,
  );
}

function tokenOf(credential: GitCredential): string {
  return credential.transport === "http-basic" ? credential.token : "";
}

function recordingRunner(
  result: Readonly<{ code: number; stderr?: string; erase?: boolean }>,
): { runner: GitRunner; requests: GitRunRequest[] } {
  const requests: GitRunRequest[] = [];
  const runner: GitRunner = async (request) => {
    requests.push(request);
    if (result.erase === true) {
      const logPath = request.extraEnv?.KANTHORD_HELPER_LOG;
      if (logPath !== undefined) {
        writeFileSync(logPath, "erase\n");
      }
    }
    return {
      code: result.code,
      stdout: "",
      stderr: result.stderr ?? "",
      args: request.args,
    };
  };
  return { runner, requests };
}

const fixtureUrl = (): string => httpRemote.url("fixture.git");

describe("src/services/git/preflight.test", () => {
  describe("the argument vector, no process", () => {
    const oid = "251c92d5a215053aea80432f179653f99072835d";
    const remoteUrl = "https://forge.test/r.git";

    it("records gitDir push --dry-run -- url oid:ref and nothing else", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner({ code: 0 });
      const input: CanPushInput = {
        gitDir: "/tmp/s.git",
        remoteUrl,
        publishRef: "refs/heads/main",
        proposedOid: oid,
        credential: httpBasic("writer", "w-tok"),
      };
      const verdict = await canPush(runner, paths, input);
      assert.deepEqual(verdict, { allowed: true });
      assert.equal(requests.length, 1);
      const args = requests[0]!.args;
      assert.deepEqual(args, [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${join(paths.keyDirectory, HELPER_FILE_NAME)}`,
        "--git-dir=/tmp/s.git",
        "push",
        "--dry-run",
        "--",
        remoteUrl,
        `${oid}:refs/heads/main`,
      ]);
      assert.equal(args.includes("--dry-run"), true);
      for (const forbidden of [
        "--force",
        "--force-with-lease",
        "--atomic",
        "--delete",
      ]) {
        assert.equal(args.includes(forbidden), false, forbidden);
      }
    });

    it("keeps a hyphen-leading publishRef after the -- separator", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner({ code: 0 });
      const publishRef = "-refs/heads/x";
      await canPush(runner, paths, {
        gitDir: "/tmp/s.git",
        remoteUrl,
        publishRef,
        proposedOid: oid,
        credential: httpBasic("writer", "w-tok"),
      });
      const args = requests[0]!.args;
      const separator = args.indexOf("--");
      assert.equal(args[separator + 1], remoteUrl);
      assert.equal(args[separator + 2], `${oid}:${publishRef}`);
    });

    it("refuses a refused url before any request is recorded", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner({ code: 0 });
      const rejection = await canPush(runner, paths, {
        gitDir: "/tmp/s.git",
        remoteUrl: "http://forge.test/r.git",
        publishRef: "refs/heads/main",
        proposedOid: oid,
        credential: httpBasic("writer", "w-tok"),
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(rejection.failure, "url-refused");
      assert.equal(requests.length, 0);
    });

    it("refuses a transport disagreement before any request is recorded", async () => {
      const paths = makePaths();
      const { runner, requests } = recordingRunner({ code: 0 });
      const rejection = await canPush(runner, paths, {
        gitDir: "/tmp/s.git",
        remoteUrl,
        publishRef: "refs/heads/main",
        proposedOid: oid,
        credential: { transport: "ssh", privateKey: "not-used" },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(rejection.failure, "url-refused");
      assert.equal(
        rejection.message,
        "the url transport and the credential transport disagree",
      );
      assert.equal(requests.length, 0);
    });
  });

  describe("the verdict table, no process", () => {
    const input = (): CanPushInput => ({
      gitDir: "/tmp/s.git",
      remoteUrl: "https://forge.test/r.git",
      publishRef: "refs/heads/main",
      proposedOid: "251c92d5a215053aea80432f179653f99072835d",
      credential: httpBasic("writer", "w-tok"),
    });

    it("code 0 yields allowed", async () => {
      const paths = makePaths();
      const { runner } = recordingRunner({ code: 0 });
      const verdict = await canPush(runner, paths, input());
      assert.deepEqual(verdict, { allowed: true });
    });

    it("an authentication failure yields auth-failed with the detail", async () => {
      const paths = makePaths();
      const stderr = "fatal: Authentication failed for 'https://f/r.git/'";
      const { runner } = recordingRunner({ code: 128, stderr });
      const verdict = await canPush(runner, paths, input());
      assert.deepEqual(verdict, {
        allowed: false,
        failure: "auth-failed",
        detail: stderr,
      });
    });

    it("a pre-receive hook decline is permission-denied", async () => {
      const paths = makePaths();
      const stderr = "remote: error: pre-receive hook declined";
      const { runner } = recordingRunner({ code: 128, stderr });
      const verdict = await canPush(runner, paths, input());
      assert.deepEqual(verdict, {
        allowed: false,
        failure: "permission-denied",
        detail: stderr,
      });
    });

    it("a protected-branch decline is permission-denied", async () => {
      const paths = makePaths();
      const stderr = "remote: error: protected branch hook declined";
      const { runner } = recordingRunner({ code: 128, stderr });
      const verdict = await canPush(runner, paths, input());
      assert.deepEqual(verdict, {
        allowed: false,
        failure: "permission-denied",
        detail: stderr,
      });
    });

    it("an unable-to-access failure is transport-failed", async () => {
      const paths = makePaths();
      const stderr = "fatal: unable to access 'https://f/r.git/'";
      const { runner } = recordingRunner({ code: 128, stderr });
      const verdict = await canPush(runner, paths, input());
      assert.deepEqual(verdict, {
        allowed: false,
        failure: "transport-failed",
        detail: stderr,
      });
    });

    it("a terminal-prompt refusal is unknown", async () => {
      const paths = makePaths();
      const stderr =
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
      const { runner } = recordingRunner({ code: 128, stderr });
      const verdict = await canPush(runner, paths, input());
      assert.deepEqual(verdict, {
        allowed: false,
        failure: "unknown",
        detail: stderr,
      });
    });

    it("the helper's erase outranks a network-looking message", async () => {
      const paths = makePaths();
      const { runner } = recordingRunner({
        code: 128,
        stderr: "Connection refused",
        erase: true,
      });
      const verdict = await canPush(runner, paths, input());
      assert.deepEqual(verdict, {
        allowed: false,
        failure: "auth-failed",
        detail: "Connection refused",
      });
    });

    it("strips userinfo from the detail", async () => {
      const paths = makePaths();
      const { runner } = recordingRunner({
        code: 128,
        stderr:
          "fatal: Authentication failed for 'https://user:secret@forge.test/r.git'",
      });
      const verdict = await canPush(runner, paths, input());
      assert.equal(verdict.allowed, false);
      if (verdict.allowed === false) {
        assert.equal(
          verdict.detail,
          "fatal: Authentication failed for 'https://forge.test/r.git'",
        );
        assert.equal(verdict.detail.includes("user:secret"), false);
      }
    });
  });

  describe("against the http fixture", () => {
    async function buildStagingHome(
      paths: GitPaths,
    ): Promise<{ runner: GitRunner; stagingDir: string; U: string }> {
      const runner = createGitRunner(paths);
      const stagingDir = join(dirname(paths.home), "staging.git");
      const init = await runner({
        args: ["init", "--bare", "--template=", stagingDir],
      });
      assert.equal(init.code, 0, init.stderr);
      const addRemote = await runner({
        args: [
          "--git-dir=" + stagingDir,
          "remote",
          "add",
          "origin",
          fixtureUrl(),
        ],
      });
      assert.equal(addRemote.code, 0, addRemote.stderr);
      const fetchRefspec = await runner({
        args: [
          "--git-dir=" + stagingDir,
          "config",
          "remote.origin.fetch",
          TRACKING_REFSPEC,
        ],
      });
      assert.equal(fetchRefspec.code, 0, fetchRefspec.stderr);
      await fetchTracking(runner, paths, {
        gitDir: stagingDir,
        credential: writerCredential(),
        pidFile: join(paths.runDirectory, "staging-fetch.pid"),
      });
      const resolve = await runner({
        args: [
          "--git-dir=" + stagingDir,
          "rev-parse",
          "--verify",
          "refs/remotes/origin/main",
        ],
      });
      assert.equal(resolve.code, 0, resolve.stderr);
      const U = resolve.stdout.trim();
      assert.equal(U, "251c92d5a215053aea80432f179653f99072835d");
      return { runner, stagingDir, U };
    }

    function assertNoGitPidFiles(paths: GitPaths): void {
      for (const entry of readdirSync(paths.runDirectory)) {
        assert.equal(entry.startsWith("git-"), false, entry);
      }
    }

    it("a write credential is allowed and no pid file survives", async () => {
      const paths = makePaths();
      const { runner, stagingDir, U } = await buildStagingHome(paths);
      const verdict = await canPush(runner, paths, {
        gitDir: stagingDir,
        remoteUrl: fixtureUrl(),
        publishRef: "refs/heads/main",
        proposedOid: U,
        credential: writerCredential(),
      });
      assert.deepEqual(verdict, { allowed: true });
      assertNoGitPidFiles(paths);
    });

    it("a read-only credential that fetches successfully is refused", async () => {
      const paths = makePaths();
      const { runner, stagingDir, U } = await buildStagingHome(paths);
      const reader = readerCredential();
      const fetchOutcome = await runAuthenticated(runner, paths, {
        credential: reader,
        args: [
          "--git-dir=" + stagingDir,
          "fetch",
          "origin",
          "--prune",
          "--no-tags",
          TRACKING_REFSPEC,
        ],
      });
      assert.equal(fetchOutcome.code, 0, fetchOutcome.stderr);
      const verdict = await canPush(runner, paths, {
        gitDir: stagingDir,
        remoteUrl: fixtureUrl(),
        publishRef: "refs/heads/main",
        proposedOid: U,
        credential: reader,
      });
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.failure, "auth-failed");
      assertNoGitPidFiles(paths);
    });

    it("a wrong token is refused and the verdict does not depend on the wording", async () => {
      const paths = makePaths();
      const { runner, stagingDir, U } = await buildStagingHome(paths);
      const wrong = wrongCredential();
      const verdict = await canPush(runner, paths, {
        gitDir: stagingDir,
        remoteUrl: fixtureUrl(),
        publishRef: "refs/heads/main",
        proposedOid: U,
        credential: wrong,
      });
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.failure, "auth-failed");
      const observed = await runAuthenticated(runner, paths, {
        credential: wrong,
        args: [
          "--git-dir=" + stagingDir,
          "push",
          "--dry-run",
          "--",
          fixtureUrl(),
          `${U}:refs/heads/main`,
        ],
      });
      assert.equal(
        classifyFailure({
          code: observed.code,
          stderr: "",
          eraseObserved: observed.eraseObserved,
        }),
        "auth-failed",
      );
      assertNoGitPidFiles(paths);
    });

    it("the remote ref did not move under any of the three credentials", async () => {
      const paths = makePaths();
      const { runner, stagingDir, U } = await buildStagingHome(paths);
      for (const credential of [
        writerCredential(),
        readerCredential(),
        wrongCredential(),
      ]) {
        const before = await remoteRefValue(runner, paths, {
          remoteUrl: fixtureUrl(),
          ref: "refs/heads/main",
          credential: writerCredential(),
        });
        const verdict = await canPush(runner, paths, {
          gitDir: stagingDir,
          remoteUrl: fixtureUrl(),
          publishRef: "refs/heads/main",
          proposedOid: U,
          credential,
        });
        const after = await remoteRefValue(runner, paths, {
          remoteUrl: fixtureUrl(),
          ref: "refs/heads/main",
          credential: writerCredential(),
        });
        assert.equal(before, U);
        assert.equal(after, U);
      }
    });

    it("a new publish ref is not created by the dry run", async () => {
      const paths = makePaths();
      const { runner, stagingDir, U } = await buildStagingHome(paths);
      const publishRef = "refs/heads/kanthord/preflight";
      assert.equal(
        await remoteRefValue(runner, paths, {
          remoteUrl: fixtureUrl(),
          ref: publishRef,
          credential: writerCredential(),
        }),
        null,
      );
      const verdict = await canPush(runner, paths, {
        gitDir: stagingDir,
        remoteUrl: fixtureUrl(),
        publishRef,
        proposedOid: U,
        credential: writerCredential(),
      });
      assert.deepEqual(verdict, { allowed: true });
      assert.equal(
        await remoteRefValue(runner, paths, {
          remoteUrl: fixtureUrl(),
          ref: publishRef,
          credential: writerCredential(),
        }),
        null,
      );
    });

    it("the token appears nowhere after a failing case", async () => {
      const paths = makePaths();
      const { runner, stagingDir, U } = await buildStagingHome(paths);
      const wrong = wrongCredential();
      const verdict = await canPush(runner, paths, {
        gitDir: stagingDir,
        remoteUrl: fixtureUrl(),
        publishRef: "refs/heads/main",
        proposedOid: U,
        credential: wrong,
      });
      assert.equal(verdict.allowed, false);
      if (verdict.allowed === false) {
        assert.equal(verdict.detail.includes(tokenOf(wrong)), false);
      }
      const observed = await runAuthenticated(runner, paths, {
        credential: wrong,
        args: [
          "--git-dir=" + stagingDir,
          "push",
          "--dry-run",
          "--",
          fixtureUrl(),
          `${U}:refs/heads/main`,
        ],
      });
      assert.equal(observed.stderr.includes(tokenOf(wrong)), false);
      const config = readFileSync(join(stagingDir, "config"), "utf8");
      assert.equal(config.includes(tokenOf(wrong)), false);
    });
  });
});
