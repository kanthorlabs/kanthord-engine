import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { createHttpRemote } from "../../../test/helpers/remote/index.ts";
import type { HttpRemote } from "../../../test/helpers/remote/index.ts";
import { createSshRemote } from "../../../test/helpers/remote/index.ts";
import type { SshRemote } from "../../../test/helpers/remote/index.ts";

import { GitError, type GitCredential, type GitPaths } from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunner } from "./run.ts";
import { parseBranches, parseSymref, remoteInfo } from "./remote-info.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

let httpRemote: HttpRemote;
let sshRemote: SshRemote;

before(async () => {
  httpRemote = await createHttpRemote();
  sshRemote = await createSshRemote();
});

after(async () => {
  await httpRemote?.dispose();
  await sshRemote?.dispose();
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-remote-info-"));
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

function writerCredential(): GitCredential {
  return {
    transport: "http-basic",
    forge: "github",
    username: httpRemote.credentials.writer.username,
    token: httpRemote.credentials.writer.token,
  };
}

function wrongCredential(): GitCredential {
  return {
    transport: "http-basic",
    forge: "github",
    username: httpRemote.wrongCredential.username,
    token: httpRemote.wrongCredential.token,
  };
}

describe("src/services/git/remote-info.test", () => {
  describe("parseSymref", () => {
    it("returns the short branch name of a symref line", () => {
      assert.equal(
        parseSymref(
          "ref: refs/heads/main\tHEAD\n7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca\tHEAD\n",
        ),
        "main",
      );
    });

    it("keeps a nested branch name intact", () => {
      assert.equal(
        parseSymref("ref: refs/heads/feature/a\tHEAD\n"),
        "feature/a",
      );
    });

    it("returns null for empty output", () => {
      assert.equal(parseSymref(""), null);
    });

    it("returns null when only an object-id line is present", () => {
      assert.equal(
        parseSymref("7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca\tHEAD\n"),
        null,
      );
    });
  });

  describe("parseBranches", () => {
    it("returns the short names bytewise sorted regardless of input order", () => {
      const text = [
        "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca\trefs/heads/zeta",
        "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca\trefs/heads/alpha",
        "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca\trefs/heads/mu",
      ].join("\n");
      assert.deepEqual(parseBranches(text), ["alpha", "mu", "zeta"]);
    });

    it("drops a tag line and a malformed line", () => {
      const text = [
        "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca\trefs/heads/main",
        "3e5b142033c55afaa59871afbe0a5f1e3947743f\trefs/tags/v1",
        "not-a-40-hex-oid\trefs/heads/broken",
        "",
      ].join("\n");
      assert.deepEqual(parseBranches(text), ["main"]);
    });
  });

  describe("remoteInfo against the http fixture", () => {
    it("resolves the default branch from the symref and reports no tag", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const info = await remoteInfo(runner, paths, {
        remoteUrl: httpRemote.url("fixture.git"),
        credential: writerCredential(),
      });
      assert.deepEqual(info, { defaultBranch: "main", branches: ["main"] });
    });

    it("yields a null default branch for an unborn HEAD, not an error", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const unbornPath = join(httpRemote.seed.path, "unborn.git");
      httpRemote.seed.git("fixture.git", [
        "init",
        "--bare",
        "--template=",
        unbornPath,
      ]);
      const info = await remoteInfo(runner, paths, {
        remoteUrl: httpRemote.url("unborn.git"),
        credential: writerCredential(),
      });
      assert.deepEqual(info, { defaultBranch: null, branches: [] });
    });

    it("refuses an https url with an ssh credential before any process runs", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const rejection = await remoteInfo(runner, paths, {
        remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
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
    });

    it("proves the disagreement refusal precedes any git invocation", async () => {
      const paths: GitPaths = {
        ...makePaths(),
        git: join(tmpdir(), `nonexistent-git-${Date.now()}`),
      };
      const runner = createGitRunner(paths);
      const rejection = await remoteInfo(runner, paths, {
        remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
        credential: { transport: "ssh", privateKey: "not-used" },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(rejection.failure, "url-refused");
    });

    it("carries no credential value in a transport-failed error", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const token = httpRemote.credentials.writer.token;
      const rejection = await remoteInfo(runner, paths, {
        remoteUrl: "http://127.0.0.1:1/fixture.git",
        credential: writerCredential(),
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(rejection.failure, "transport-failed");
      assert.equal(rejection.message.includes(token), false);
      assert.equal(rejection.detail.includes(token), false);
    });

    it("never presents a credential against a public read", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      await remoteInfo(runner, paths, {
        remoteUrl: httpRemote.url("fixture.git"),
        credential: wrongCredential(),
      });
      const uploads = httpRemote
        .requestLog()
        .filter((record) => record.path.includes("service=git-upload-pack"));
      const last = uploads[uploads.length - 1];
      assert.ok(last !== undefined, "an upload-pack request was recorded");
      assert.equal(last.username, null);
    });
  });

  describe("remoteInfo against the ssh fixture", () => {
    it("rejects a key the fixture does not authorize as auth-failed", async () => {
      const paths = makePaths();
      copyFileSync(
        sshRemote.writeKnownHosts(sshRemote.hostKeys),
        paths.knownHosts,
      );
      const runner = createGitRunner(paths);
      const keyDir = mkdtempSync(join(tmpdir(), "kanthord-remote-info-key-"));
      try {
        execFileSync(
          tools.paths.sshKeygen,
          ["-t", "ed25519", "-N", "", "-f", join(keyDir, "client")],
          { env: {}, encoding: "utf8" },
        );
        const privateKey = readFileSync(join(keyDir, "client"), "utf8");
        const rejection = await remoteInfo(runner, paths, {
          remoteUrl: sshRemote.url("fixture.git"),
          credential: { transport: "ssh", privateKey },
        }).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(rejection instanceof GitError, String(rejection));
        assert.equal(rejection.failure, "auth-failed");
        const fingerprint = privateKey.trim().split("\n").at(-1) ?? privateKey;
        assert.equal(rejection.message.includes(fingerprint), false);
        assert.equal(rejection.detail.includes(fingerprint), false);
      } finally {
        rmSync(keyDir, { recursive: true, force: true });
      }
    });
  });
});
