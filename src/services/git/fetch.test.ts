import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { createHttpRemote } from "../../../test/helpers/remote/index.ts";
import type { HttpRemote } from "../../../test/helpers/remote/index.ts";
import { fixtureObjectIds } from "../../../test/helpers/remote/seed.ts";

import {
  GitError,
  TRACKING_REFSPEC,
  type GitCredential,
  type GitPaths,
} from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunner, GitRunResult } from "./run.ts";
import { fetchTracking } from "./fetch.ts";
import type { FetchInput } from "./fetch.ts";

const tools: Tools = resolveTools();

const c1 = "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca";
const c2 = "251c92d5a215053aea80432f179653f99072835d";

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
  const dir = mkdtempSync(join(tmpdir(), "kanthord-fetch-"));
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

function fetchInput(paths: GitPaths, credential: GitCredential): FetchInput {
  return {
    gitDir: paths.home,
    credential,
    pidFile: join(paths.home, `fetch-${randomUUID()}.pid`),
  };
}

async function runGit(
  runner: GitRunner,
  paths: GitPaths,
  args: readonly string[],
): Promise<GitRunResult> {
  return runner({ args: ["--git-dir=" + paths.home, ...args] });
}

async function prepareHome(
  runner: GitRunner,
  paths: GitPaths,
  url: string,
): Promise<void> {
  const init = await runner({
    args: [
      "init",
      "--bare",
      "--template=",
      "--initial-branch=main",
      paths.home,
    ],
  });
  assert.equal(init.code, 0, init.stderr);
  const addRemote = await runGit(runner, paths, [
    "remote",
    "add",
    "origin",
    url,
  ]);
  assert.equal(addRemote.code, 0, addRemote.stderr);
  const setRefspec = await runGit(runner, paths, [
    "config",
    "remote.origin.fetch",
    TRACKING_REFSPEC,
  ]);
  assert.equal(setRefspec.code, 0, setRefspec.stderr);
}

async function forEachRef(
  runner: GitRunner,
  paths: GitPaths,
): Promise<readonly string[]> {
  const result = await runGit(runner, paths, [
    "for-each-ref",
    "--format=%(refname)",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const names = result.stdout.trim();
  if (names === "") {
    return [];
  }
  return names.split("\n").sort();
}

async function revParse(
  runner: GitRunner,
  paths: GitPaths,
  ref: string,
): Promise<string> {
  const result = await runGit(runner, paths, ["rev-parse", "--verify", ref]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

describe("src/services/git/fetch.test", () => {
  it("the pinned object ids match the fixture", () => {
    assert.equal(fixtureObjectIds.commit1, c1);
    assert.equal(fixtureObjectIds.commit2, c2);
  });

  it("TRACKING_REFSPEC is the documented refspec", () => {
    assert.equal(TRACKING_REFSPEC, "+refs/heads/*:refs/remotes/origin/*");
  });

  it("a fetch writes the tracking namespace only", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    await prepareHome(runner, paths, httpRemote.url("fixture.git"));
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    const refs = await forEachRef(runner, paths);
    assert.ok(refs.includes("refs/remotes/origin/main"), refs.join(","));
    const permitted = new Set([
      "refs/remotes/origin/main",
      "refs/remotes/origin/HEAD",
    ]);
    for (const ref of refs) {
      assert.ok(ref.startsWith("refs/remotes/origin/"), ref);
      assert.ok(permitted.has(ref), ref);
    }
  });

  it("a tagged remote leaves refs/tags empty", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    await prepareHome(runner, paths, httpRemote.url("fixture.git"));
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    const tags = await runGit(runner, paths, ["for-each-ref", "refs/tags"]);
    assert.equal(tags.code, 0, tags.stderr);
    assert.equal(tags.stdout.trim(), "");
  });

  it("a force-push moves the tracking ref and not the landing branch", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    await prepareHome(runner, paths, httpRemote.url("fixture.git"));
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    const land = await runGit(runner, paths, [
      "update-ref",
      "refs/heads/land",
      c2,
      "",
    ]);
    assert.equal(land.code, 0, land.stderr);
    httpRemote.seed.git("fixture.git", [
      "update-ref",
      "refs/heads/main",
      c1,
      c2,
    ]);
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    assert.equal(await revParse(runner, paths, "refs/remotes/origin/main"), c1);
    assert.equal(await revParse(runner, paths, "refs/heads/land"), c2);
  });

  it("a second fetch after the landing write does not move the landing branch", async () => {
    httpRemote.seed.git("fixture.git", ["update-ref", "refs/heads/main", c2]);
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    await prepareHome(runner, paths, httpRemote.url("fixture.git"));
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    const land = await runGit(runner, paths, [
      "update-ref",
      "refs/heads/land",
      c2,
      "",
    ]);
    assert.equal(land.code, 0, land.stderr);
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    assert.equal(await revParse(runner, paths, "refs/heads/land"), c2);
  });

  it("a failed fetch throws a classified error and writes no tracking ref", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    await prepareHome(runner, paths, httpRemote.url("fixture.git"));
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    const before = await forEachRef(runner, paths);
    const setUrl = await runGit(runner, paths, [
      "remote",
      "set-url",
      "origin",
      "http://127.0.0.1:1/fixture.git",
    ]);
    assert.equal(setUrl.code, 0, setUrl.stderr);
    const rejection = await fetchTracking(
      runner,
      paths,
      fetchInput(paths, credential),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "transport-failed");
    assert.ok(
      rejection.message.startsWith("git fetch failed with code "),
      rejection.message,
    );
    const after = await forEachRef(runner, paths);
    assert.deepEqual(after, before);
  });

  it("the error carries no userinfo", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.wrongCredential.username,
      token: httpRemote.wrongCredential.token,
    };
    await prepareHome(
      runner,
      paths,
      "http://writer:bad-tok@127.0.0.1:1/fixture.git",
    );
    const rejection = await fetchTracking(
      runner,
      paths,
      fetchInput(paths, credential),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.ok(!rejection.detail.includes("writer@"), rejection.detail);
    assert.ok(!rejection.detail.includes("bad-tok"), rejection.detail);
    assert.ok(rejection.detail.includes("127.0.0.1"), rejection.detail);
  });

  it("FETCH_HEAD is not a failure", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    await prepareHome(runner, paths, httpRemote.url("fixture.git"));
    await fetchTracking(runner, paths, fetchInput(paths, credential));
    assert.equal(existsSync(join(paths.home, "FETCH_HEAD")), true);
  });
});
