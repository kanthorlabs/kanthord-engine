import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import {
  createHttpRemote,
  createSshRemote,
  fixtureObjectIds,
} from "../../../test/helpers/remote/index.ts";
import type {
  HttpRemote,
  SshRemote,
} from "../../../test/helpers/remote/index.ts";

import {
  GitError,
  TRACKING_REFSPEC,
  type GitCredential,
  type GitPaths,
  type HostKey,
} from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunRequest, GitRunner } from "./run.ts";
import { HELPER_FILE_NAME } from "./credential.ts";
import { seedHome, stagingPathFor } from "./seed.ts";
import type { SeedHomeExtended } from "./seed.ts";
import { confirmHostKey, knownHostsLine, scanTargetFor } from "./host-key.ts";
import { remoteRefValue } from "./preflight.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "kanthord-seed-"));
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

function sshCredential(): GitCredential {
  return {
    transport: "ssh",
    privateKey: readFileSync(sshRemote.privateKeyPath, "utf8"),
  };
}

function seedInput(
  paths: GitPaths,
  gitDir: string,
  overrides?: Readonly<{
    remoteUrl?: string;
    branch?: string;
    hostKey?: HostKey | null;
    credential?: GitCredential;
  }>,
): SeedHomeExtended {
  return {
    gitDir,
    remoteUrl: overrides?.remoteUrl ?? httpRemote.url("fixture.git"),
    branch: overrides?.branch ?? "main",
    hostKey: overrides?.hostKey === undefined ? null : overrides.hostKey,
    credential: overrides?.credential ?? writerCredential(),
    pidFile: join(paths.runDirectory, "seed.pid"),
  };
}

function recordingRunner(oid: string): {
  runner: GitRunner;
  requests: GitRunRequest[];
} {
  const requests: GitRunRequest[] = [];
  const runner: GitRunner = async (request) => {
    requests.push(request);
    const isInit = request.args[0] === "init";
    if (isInit) {
      const staging = request.args[request.args.length - 1]!;
      mkdirSync(staging);
    }
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

function forEachRef(
  runner: GitRunner,
  gitDir: string,
  pattern: string,
): Promise<readonly string[]> {
  return runner({
    args: [
      "--git-dir=" + gitDir,
      "for-each-ref",
      "--format=%(refname)",
      pattern,
    ],
  }).then((result) => {
    assert.equal(result.code, 0, result.stderr);
    const text = result.stdout.trim();
    return text === "" ? [] : text.split("\n");
  });
}

function stagingEntries(parent: string): string[] {
  return readdirSync(parent).filter((name) => name.startsWith(".staging-"));
}

const oid: string = fixtureObjectIds.commit2!;

describe("src/services/git/seed.test", () => {
  describe("the command sequence, no process", () => {
    const remoteUrl = "https://forge.test/r.git";
    const publishRef = "refs/heads/main";

    it("records the nine-step sequence in order with TRACKING_REFSPEC and the pinned init flags", async () => {
      const paths = makePaths();
      const gitDir = join(dirname(paths.home), "home.git");
      const { runner, requests } = recordingRunner(oid);
      await seedHome(runner, paths, seedInput(paths, gitDir, { remoteUrl }));
      const initArgs = requests[0]!.args;
      const staging = initArgs[initArgs.indexOf("--") + 1]!;
      const helper = join(paths.keyDirectory, HELPER_FILE_NAME);
      assert.deepEqual(
        requests.map((request) => request.args),
        [
          [
            "init",
            "--bare",
            "--template=",
            "--object-format=sha1",
            "--initial-branch=main",
            "--",
            staging,
          ],
          ["--git-dir=" + staging, "remote", "add", "origin", "--", remoteUrl],
          [
            "--git-dir=" + staging,
            "config",
            "remote.origin.fetch",
            TRACKING_REFSPEC,
          ],
          [
            "-c",
            "credential.helper=",
            "-c",
            "credential.helper=" + helper,
            "--git-dir=" + staging,
            "fetch",
            "origin",
            "--prune",
            "--no-tags",
            TRACKING_REFSPEC,
          ],
          [
            "--git-dir=" + staging,
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/main",
          ],
          [
            "-c",
            "credential.helper=",
            "-c",
            "credential.helper=" + helper,
            "--git-dir=" + staging,
            "push",
            "--dry-run",
            "--",
            remoteUrl,
            `${oid}:${publishRef}`,
          ],
          ["--git-dir=" + staging, "update-ref", "refs/heads/main", oid, ""],
        ],
      );
      assert.equal(requests[3]!.pidFile, join(paths.runDirectory, "seed.pid"));
      assert.equal(requests[6]!.pidFile, join(paths.runDirectory, "seed.pid"));
    });

    it("no recorded vector contains clone", async () => {
      const paths = makePaths();
      const gitDir = join(dirname(paths.home), "home.git");
      const { runner, requests } = recordingRunner(oid);
      await seedHome(runner, paths, seedInput(paths, gitDir, { remoteUrl }));
      for (const request of requests) {
        assert.equal(
          request.args.includes("clone"),
          false,
          request.args.join(" "),
        );
      }
    });

    it("no recorded vector contains --tags, --force, --all or --update-head-ok", async () => {
      const paths = makePaths();
      const gitDir = join(dirname(paths.home), "home.git");
      const { runner, requests } = recordingRunner(oid);
      await seedHome(runner, paths, seedInput(paths, gitDir, { remoteUrl }));
      for (const request of requests) {
        for (const forbidden of [
          "--tags",
          "--force",
          "--all",
          "--update-head-ok",
        ]) {
          assert.equal(
            request.args.includes(forbidden),
            false,
            `${forbidden} in ${request.args.join(" ")}`,
          );
        }
      }
    });

    it("the fetch vector precedes the rev-parse vector, which precedes the push --dry-run vector, which precedes the update-ref vector", async () => {
      const paths = makePaths();
      const gitDir = join(dirname(paths.home), "home.git");
      const { runner, requests } = recordingRunner(oid);
      await seedHome(runner, paths, seedInput(paths, gitDir, { remoteUrl }));
      const indexOf = (token: string): number =>
        requests.findIndex((request) => request.args.includes(token));
      const fetchIndex = indexOf("fetch");
      const revParseIndex = indexOf("rev-parse");
      const pushIndex = indexOf("push");
      const updateRefIndex = indexOf("update-ref");
      assert.ok(fetchIndex >= 0, "the fetch vector is recorded");
      assert.ok(fetchIndex < revParseIndex, "fetch precedes rev-parse");
      assert.ok(revParseIndex < pushIndex, "rev-parse precedes push");
      assert.ok(pushIndex < updateRefIndex, "push precedes update-ref");
    });

    it("with hostKey null, known_hosts is unchanged and the init vector is first", async () => {
      const paths = makePaths();
      const gitDir = join(dirname(paths.home), "home.git");
      const { runner, requests } = recordingRunner(oid);
      await seedHome(runner, paths, seedInput(paths, gitDir, { remoteUrl }));
      assert.equal(requests[0]!.args[0], "init");
      assert.equal(readFileSync(paths.knownHosts, "utf8"), "");
    });

    it("with a hostKey, known_hosts holds the line before the fetch vector was recorded", async () => {
      const paths = makePaths();
      const gitDir = join(dirname(paths.home), "home.git");
      const sshUrl = "ssh://git@forge.test/r.git";
      const hostKey: HostKey = {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:abc",
        publicKey: "AAAAkey",
      };
      const expectedLine = knownHostsLine(scanTargetFor(sshUrl), hostKey);
      const requests: GitRunRequest[] = [];
      const runner: GitRunner = async (request) => {
        if (request.args.includes("fetch")) {
          const text = readFileSync(paths.knownHosts, "utf8");
          assert.ok(text.includes(expectedLine), text);
        }
        requests.push(request);
        if (request.args[0] === "init") {
          const staging = request.args[request.args.length - 1]!;
          mkdirSync(staging);
        }
        return {
          code: 0,
          stdout: request.args.includes("rev-parse") ? oid + "\n" : "",
          stderr: "",
          args: request.args,
        };
      };
      await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir, {
          remoteUrl: sshUrl,
          hostKey,
          credential: { transport: "ssh", privateKey: "not-used" },
        }),
      );
      assert.equal(
        readFileSync(paths.knownHosts, "utf8").includes(expectedLine),
        true,
      );
      assert.equal(requests[0]!.args[0], "init");
    });

    it("stagingPathFor names a sibling under the staging prefix", () => {
      const staging = stagingPathFor("/tmp/x/home.git");
      assert.equal(dirname(staging), "/tmp/x");
      assert.ok(staging.startsWith(join("/tmp/x", ".staging-")), staging);
    });
  });

  describe("against the http fixture", () => {
    it("a registration produces the tracking namespace and exactly one landing branch", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      const result = await seedHome(runner, paths, seedInput(paths, gitDir));
      assert.equal(result.homePath, gitDir);
      assert.equal(result.fetchedUpstreamOid, oid);
      assert.equal(result.landingOid, oid);
      const tracking = await forEachRef(runner, gitDir, "refs/remotes/origin");
      assert.ok(
        tracking.includes("refs/remotes/origin/main"),
        tracking.join(","),
      );
      for (const ref of tracking) {
        assert.ok(ref.startsWith("refs/remotes/origin/"), ref);
      }
      const heads = await forEachRef(runner, gitDir, "refs/heads");
      assert.deepEqual(heads, ["refs/heads/main"]);
      const headOid = await runner({
        args: [
          "--git-dir=" + gitDir,
          "rev-parse",
          "--verify",
          "refs/heads/main",
        ],
      });
      assert.equal(headOid.code, 0, headOid.stderr);
      assert.equal(headOid.stdout.trim(), oid);
    });

    it("a non-default branch names both the tracking ref and the only local head", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      await seedHome(runner, paths, seedInput(paths, gitDir));
      const heads = await forEachRef(runner, gitDir, "refs/heads");
      assert.deepEqual(heads, ["refs/heads/main"]);
      const tracking = await forEachRef(runner, gitDir, "refs/remotes/origin");
      assert.ok(
        tracking.includes("refs/remotes/origin/main"),
        tracking.join(","),
      );
      const headOid = await runner({
        args: [
          "--git-dir=" + gitDir,
          "rev-parse",
          "--verify",
          "refs/heads/main",
        ],
      });
      assert.equal(headOid.code, 0, headOid.stderr);
      assert.equal(headOid.stdout.trim(), oid);
    });

    it("no tag is written against a tagged fixture", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      await seedHome(runner, paths, seedInput(paths, gitDir));
      const tags = await forEachRef(runner, gitDir, "refs/tags");
      assert.deepEqual(tags, []);
    });

    it("<home>/config is a closed set", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      await seedHome(runner, paths, seedInput(paths, gitDir));
      const config = readFileSync(join(gitDir, "config"), "utf8");
      assert.ok(config.includes('remote "origin"'), config);
      assert.ok(
        config.includes("url = " + httpRemote.url("fixture.git")),
        config,
      );
      assert.ok(config.includes("fetch"), config);
      for (const forbidden of [
        "include",
        "includeIf",
        "alternates",
        "partialclonefilter",
        "gpgsign",
      ]) {
        assert.ok(!config.includes(forbidden), `${forbidden} in ${config}`);
      }
    });

    it("a failed fetch leaves no visible home and no staging directory", async () => {
      const paths = makePaths();
      const inner = createGitRunner(paths);
      const runner: GitRunner = async (request) => {
        if (request.args.includes("fetch")) {
          return {
            code: 128,
            stdout: "",
            stderr: "fatal: injected fetch failure",
            args: request.args,
          };
        }
        return inner(request);
      };
      const gitDir = join(dirname(paths.home), "home.git");
      const rejection = await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.ok(
        rejection.message.includes("git fetch failed with code 128"),
        rejection.message,
      );
      assert.equal(existsSync(gitDir), false);
      assert.deepEqual(stagingEntries(dirname(gitDir)), []);
    });

    it("a crash before cleanup leaves exactly one staging directory behind", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      const crashingRunner: GitRunner = async (request) => {
        if (request.args.includes("fetch")) {
          chmodSync(dirname(gitDir), 0o500);
          throw new Error("simulated crash before cleanup");
        }
        return runner(request);
      };
      try {
        const crashRejection = await seedHome(
          crashingRunner,
          paths,
          seedInput(paths, gitDir),
        ).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(crashRejection instanceof Error, String(crashRejection));
        assert.equal(existsSync(gitDir), false);
        const leftovers = stagingEntries(dirname(gitDir));
        assert.equal(leftovers.length, 1, leftovers.join(","));
      } finally {
        chmodSync(dirname(gitDir), 0o700);
      }
    });

    it("a missing upstream branch fails and changes nothing", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      const before = await remoteRefValue(runner, paths, {
        remoteUrl: httpRemote.url("fixture.git"),
        ref: "refs/heads/main",
        credential: writerCredential(),
      });
      assert.equal(before, oid);
      const rejection = await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir, { branch: "does-not-exist" }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.ok(
        rejection.message.includes("does-not-exist"),
        rejection.message,
      );
      assert.equal(existsSync(gitDir), false);
      const after = await remoteRefValue(runner, paths, {
        remoteUrl: httpRemote.url("fixture.git"),
        ref: "refs/heads/main",
        credential: writerCredential(),
      });
      assert.equal(after, oid);
    });

    it("an existing home is refused before any work", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      mkdirSync(gitDir);
      const rejection = await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(
        rejection.message,
        "the repository home already exists",
        rejection.message,
      );
      assert.deepEqual(readdirSync(gitDir), []);
      assert.deepEqual(stagingEntries(dirname(gitDir)), []);
    });

    it("a read-only credential is refused by the preflight and leaves no home", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      const rejection = await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir, { credential: readerCredential() }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(rejection.failure, "auth-failed");
      assert.ok(
        rejection.message.includes("refs/heads/main"),
        rejection.message,
      );
      assert.equal(existsSync(gitDir), false);
    });

    it("the rename is the only thing that makes the home visible", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      let checked = false;
      const checkingRunner: GitRunner = async (request) => {
        if (request.args.includes("update-ref")) {
          const gitDirArg = request.args.find((arg) =>
            arg.startsWith("--git-dir="),
          );
          const staging = gitDirArg?.slice("--git-dir=".length) ?? "";
          assert.equal(existsSync(gitDir), false);
          assert.equal(existsSync(staging), true, staging);
          checked = true;
        }
        return runner(request);
      };
      await seedHome(checkingRunner, paths, seedInput(paths, gitDir));
      assert.equal(checked, true);
      assert.equal(existsSync(gitDir), true);
    });

    it("the token appears nowhere", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      const requests: GitRunRequest[] = [];
      const recording: GitRunner = async (request) => {
        requests.push(request);
        return runner(request);
      };
      const credential = writerCredential();
      const token =
        credential.transport === "http-basic" ? credential.token : "";
      await seedHome(recording, paths, seedInput(paths, gitDir));
      const config = readFileSync(join(gitDir, "config"), "utf8");
      assert.equal(config.includes(token), false, config);
      for (const request of requests) {
        assert.equal(
          request.args.join(" ").includes(token),
          false,
          request.args.join(" "),
        );
      }
      for (const entry of readdirSync(paths.keyDirectory)) {
        const content = readFileSync(join(paths.keyDirectory, entry), "utf8");
        assert.equal(content.includes(token), false, entry);
      }
    });
  });

  describe("against the ssh fixture", () => {
    it("an ssh url seeds with a confirmed host key", async () => {
      const paths = makePaths();
      const runner = createGitRunner(paths);
      const gitDir = join(dirname(paths.home), "home.git");
      const url = sshRemote.url("fixture.git");
      const confirmed = await confirmHostKey(
        paths,
        url,
        sshRemote.hostKeys[0]!.fingerprint,
      );
      assert.equal(confirmed.confirmed, true);
      if (!confirmed.confirmed) {
        return;
      }
      const result = await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir, {
          remoteUrl: url,
          hostKey: confirmed.hostKey,
          credential: sshCredential(),
        }),
      );
      assert.equal(result.homePath, gitDir);
      const text = readFileSync(paths.knownHosts, "utf8");
      assert.ok(
        text.includes(sshRemote.knownHostsLine(sshRemote.hostKeys[0]!)),
        text,
      );
      const heads = await forEachRef(runner, gitDir, "refs/heads");
      assert.deepEqual(heads, ["refs/heads/main"]);
      const headOid = await runner({
        args: [
          "--git-dir=" + gitDir,
          "rev-parse",
          "--verify",
          "refs/heads/main",
        ],
      });
      assert.equal(headOid.code, 0, headOid.stderr);
      assert.equal(headOid.stdout.trim(), oid);
    });

    it("a wrong host key refuses", async () => {
      const paths = makePaths();
      const runner: GitRunner = (request) =>
        createGitRunner(paths)({ ...request, timeoutMs: 15_000 });
      const gitDir = join(dirname(paths.home), "home.git");
      const rejection = await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir, {
          remoteUrl: sshRemote.url("fixture.git"),
          hostKey: sshRemote.wrongHostKey,
          credential: sshCredential(),
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(rejection.failure, "host-key-mismatch");
      assert.equal(existsSync(gitDir), false);
      const text = readFileSync(paths.knownHosts, "utf8");
      assert.ok(
        text.includes(sshRemote.knownHostsLine(sshRemote.wrongHostKey)),
        text,
      );
    });

    it("a credential whose transport disagrees with the url refuses before any process", async () => {
      const paths = makePaths();
      const gitDir = join(dirname(paths.home), "home.git");
      const { runner, requests } = recordingRunner(oid);
      const rejection = await seedHome(
        runner,
        paths,
        seedInput(paths, gitDir, {
          remoteUrl: sshRemote.url("fixture.git"),
          credential: httpBasic("writer", "w-tok"),
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof GitError, String(rejection));
      assert.equal(rejection.failure, "url-refused");
      assert.equal(requests.length, 0);
    });
  });
});
