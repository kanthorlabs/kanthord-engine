import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import {
  createHttpRemote,
  createSshRemote,
} from "../../../test/helpers/remote/index.ts";
import type {
  HttpRemote,
  SshRemote,
} from "../../../test/helpers/remote/index.ts";

import { GitError, type GitCredential, type GitPaths } from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunRequest, GitRunner } from "./run.ts";
import { classifyFailure } from "./credential.ts";
import { runAuthenticated } from "./authenticated.ts";
import { refUpdate } from "./ref-update.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "kanthord-authenticated-"));
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

function fetchArgs(paths: GitPaths): readonly string[] {
  return ["--git-dir=" + paths.home, "fetch", "origin", "--prune", "--no-tags"];
}

function pushArgs(paths: GitPaths, refName: string): readonly string[] {
  return [
    "--git-dir=" + paths.home,
    "push",
    "origin",
    `refs/remotes/origin/main:${refName}`,
  ];
}

async function prepareBareHome(
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
  const addRemote = await runner({
    args: ["--git-dir=" + paths.home, "remote", "add", "origin", url],
  });
  assert.equal(addRemote.code, 0, addRemote.stderr);
}

async function trackingRefAbsent(
  runner: GitRunner,
  paths: GitPaths,
  refName: string,
): Promise<boolean> {
  const refs = await runner({
    args: ["--git-dir=" + paths.home, "for-each-ref", "--format=%(refname)"],
  });
  assert.equal(refs.code, 0, refs.stderr);
  return !refs.stdout.split("\n").includes(refName);
}

describe("src/services/git/authenticated.test", () => {
  it("a write-capable credential fetches and observes no erase", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await prepareBareHome(runner, paths, httpRemote.url("fixture.git"));
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    const outcome = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential,
    });
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(outcome.eraseObserved, false);
    const verify = await runner({
      args: [
        "--git-dir=" + paths.home,
        "rev-parse",
        "--verify",
        "refs/remotes/origin/main",
      ],
    });
    assert.equal(verify.code, 0, verify.stderr);
  });

  it("the credential never reaches the runner request", async () => {
    const paths = makePaths();
    const recorded: unknown[] = [];
    const recordingRunner: GitRunner = async (request) => {
      recorded.push(request);
      return { code: 0, stdout: "", stderr: "", args: request.args };
    };
    const outcome = await runAuthenticated(recordingRunner, paths, {
      args: ["--version"],
      credential: {
        transport: "http-basic",
        forge: "github",
        username: "writer",
        token: "w-tok",
      },
    });
    assert.equal(outcome.code, 0);
    assert.equal(recorded.length, 1);
    const request = recorded[0] as GitRunRequest;
    assert.equal(Object.hasOwn(request, "credential"), false);
    assert.deepEqual(Object.keys(request).sort(), ["args", "extraEnv"]);
  });

  it("a wrong token is auth-failed through the erase, not through a message", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await prepareBareHome(runner, paths, httpRemote.url("fixture.git"));
    const writer: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    const seedFetch = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential: writer,
    });
    assert.equal(seedFetch.code, 0, seedFetch.stderr);
    const refName = `refs/heads/probe-${randomUUID()}`;
    const wrong: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.wrongCredential.username,
      token: httpRemote.wrongCredential.token,
    };
    const outcome = await runAuthenticated(runner, paths, {
      args: pushArgs(paths, refName),
      credential: wrong,
    });
    assert.notEqual(outcome.code, 0);
    assert.equal(outcome.eraseObserved, true);
    assert.equal(
      classifyFailure({
        code: outcome.code,
        stderr: outcome.stderr,
        eraseObserved: outcome.eraseObserved,
      }),
      "auth-failed",
    );
    assert.equal(
      classifyFailure({
        code: outcome.code,
        stderr: "",
        eraseObserved: outcome.eraseObserved,
      }),
      "auth-failed",
    );
  });

  it("a missing credential fails and writes nothing", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await prepareBareHome(runner, paths, httpRemote.url("fixture.git"));
    const writer: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: httpRemote.credentials.writer.username,
      token: httpRemote.credentials.writer.token,
    };
    const seedFetch = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential: writer,
    });
    assert.equal(seedFetch.code, 0, seedFetch.stderr);
    const refName = `refs/heads/probe-${randomUUID()}`;
    const result = await runner({ args: pushArgs(paths, refName) });
    assert.notEqual(result.code, 0);
    assert.equal(await trackingRefAbsent(runner, paths, refName), true);
  });

  it("the token appears nowhere, asserted by construction", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await prepareBareHome(runner, paths, httpRemote.url("fixture.git"));
    const writer = httpRemote.credentials.writer;
    const credential: GitCredential = {
      transport: "http-basic",
      forge: "github",
      username: writer.username,
      token: writer.token,
    };
    const seedFetch = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential,
    });
    assert.equal(seedFetch.code, 0, seedFetch.stderr);
    const refName = `refs/heads/probe-${randomUUID()}`;
    const outcome = await runAuthenticated(runner, paths, {
      args: pushArgs(paths, refName),
      credential,
    });
    assert.equal(outcome.code, 0, outcome.stderr);
    for (const arg of outcome.args) {
      assert.ok(!arg.includes(writer.token), arg);
    }
    const config = readFileSync(join(paths.home, "config"), "utf8");
    assert.ok(!config.includes(writer.token), config);
    const helperScript = readFileSync(
      join(paths.keyDirectory, "credential-helper.sh"),
      "utf8",
    );
    assert.ok(!helperScript.includes(writer.token), helperScript);
    const failure = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential,
      timeoutMs: 10,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof GitError, String(failure));
    assert.equal(failure.failure, "timed-out");
    assert.deepEqual(Object.keys(failure).sort(), [
      "detail",
      "failure",
      "name",
    ]);
    for (const field of [
      failure.name,
      failure.failure,
      failure.detail,
      failure.message,
    ]) {
      assert.ok(!field.includes(writer.token), field);
    }
    const serialized = JSON.stringify(failure);
    assert.ok(!serialized.includes(writer.token), serialized);
  });

  it("ssh with a correct pin fetches and the tracking ref resolves", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    copyFileSync(
      sshRemote.writeKnownHosts(sshRemote.hostKeys),
      paths.knownHosts,
    );
    await prepareBareHome(runner, paths, sshRemote.url("fixture.git"));
    const credential: GitCredential = {
      transport: "ssh",
      privateKey: readFileSync(sshRemote.privateKeyPath, "utf8"),
    };
    const outcome = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential,
    });
    assert.equal(outcome.code, 0, outcome.stderr);
    const verify = await runner({
      args: [
        "--git-dir=" + paths.home,
        "rev-parse",
        "--verify",
        "refs/remotes/origin/main",
      ],
    });
    assert.equal(verify.code, 0, verify.stderr);
  });

  it("ssh with a correct pin also refUpdates the landing branch", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    copyFileSync(
      sshRemote.writeKnownHosts(sshRemote.hostKeys),
      paths.knownHosts,
    );
    await prepareBareHome(runner, paths, sshRemote.url("fixture.git"));
    const credential: GitCredential = {
      transport: "ssh",
      privateKey: readFileSync(sshRemote.privateKeyPath, "utf8"),
    };
    const outcome = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential,
    });
    assert.equal(outcome.code, 0, outcome.stderr);
    const tracking = await runner({
      args: [
        "--git-dir=" + paths.home,
        "rev-parse",
        "--verify",
        "refs/remotes/origin/main",
      ],
    });
    assert.equal(tracking.code, 0, tracking.stderr);
    const trackingOid = tracking.stdout.trim();
    const update = await refUpdate(runner, {
      gitDir: paths.home,
      ref: "refs/heads/land",
      expectedOid: null,
      nextOid: trackingOid,
      pidFile: join(paths.home, "land.pid"),
    });
    assert.deepEqual(update, { updated: true, oid: trackingOid });
  });

  it("ssh with a wrong pin is host-key-mismatch", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    copyFileSync(
      sshRemote.writeKnownHosts([sshRemote.wrongHostKey]),
      paths.knownHosts,
    );
    await prepareBareHome(runner, paths, sshRemote.url("fixture.git"));
    const credential: GitCredential = {
      transport: "ssh",
      privateKey: readFileSync(sshRemote.privateKeyPath, "utf8"),
    };
    const outcome = await runAuthenticated(runner, paths, {
      args: fetchArgs(paths),
      credential,
      timeoutMs: 15_000,
    }).then(
      (outcomeValue) => outcomeValue,
      (error: unknown) => {
        assert.fail(`expected a resolution, got a rejection: ${String(error)}`);
      },
    );
    assert.notEqual(outcome.code, 0);
    assert.equal(
      classifyFailure({
        code: outcome.code,
        stderr: outcome.stderr,
        eraseObserved: outcome.eraseObserved,
      }),
      "host-key-mismatch",
    );
  });

  it("a thrown operation still removes the key file", async () => {
    const paths = makePaths();
    const sshPidPath = join(paths.home, "ssh.pid");
    const statPath = join(paths.home, "key-stat.txt");
    const fakeSsh = join(paths.home, "fake-ssh.sh");
    writeFileSync(
      fakeSsh,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$$" > '${sshPidPath}'`,
        `/bin/ls -l "$KANTHORD_SSH_KEY" > '${statPath}'`,
        "/bin/sleep 30",
      ].join("\n"),
      { mode: 0o700 },
    );
    const pathsWithFakeSsh = { ...paths, ssh: fakeSsh };
    const runner = createGitRunner(pathsWithFakeSsh);
    const rejection = await runAuthenticated(runner, pathsWithFakeSsh, {
      args: ["ls-remote", "ssh://127.0.0.1:1/r.git"],
      credential: { transport: "ssh", privateKey: "probe-key\n" },
      timeoutMs: 2000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "timed-out");
    const entries = readdirSync(paths.keyDirectory);
    assert.equal(
      entries.some((name) => name.startsWith("key-")),
      false,
      entries.join(","),
    );
    const statOutput = readFileSync(statPath, "utf8");
    assert.ok(statOutput.includes("-rw-------"), statOutput);
  });
});
