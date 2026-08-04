import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createHttpRemote,
  createRemotes,
  createSshRemote,
  FixtureError,
  fixtureTransports,
} from "./index.ts";
import { httpAcceptanceChecks } from "./http.ts";
import type { HttpRemote } from "./http.ts";
import { sshAcceptanceChecks } from "./ssh.ts";
import type { SshRemote } from "./ssh.ts";
import {
  fixtureObjectIds,
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
} from "./seed.ts";
import { resolveTools, ToolError, toolTimeoutMilliseconds } from "./tools.ts";
import type { Tools } from "./tools.ts";

const spawnGuard = {
  timeout: toolTimeoutMilliseconds,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

const temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), "kanthord-index-root-"));
process.env.TMPDIR = temporaryRoot;
after(() =>
  fs.rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  }),
);

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const execGit = promisify(execFile);

async function gitLsRemote(tools: Tools, url: string): Promise<string> {
  const { stdout } = await execGit(
    tools.paths.git,
    [...pinnedGitConfigArguments, "ls-remote", url],
    { env: { ...pinnedGitEnvironment, PATH: tools.execPath }, ...spawnGuard },
  );
  return stdout.toString();
}

function assertPortRefused(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`port ${port} still accepts connections`));
    });
    socket.once("error", () => {
      socket.destroy();
      resolve();
    });
  });
}

function tmpEntries(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith("kanthord-"))
    .sort();
}

function findSshdDirectory(port: number): string {
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith("kanthord-sshd-")) {
      continue;
    }
    const configPath = join(os.tmpdir(), entry, "sshd_config");
    if (!fs.existsSync(configPath)) {
      continue;
    }
    if (fs.readFileSync(configPath, "utf8").includes(`Port ${port}`)) {
      return join(os.tmpdir(), entry);
    }
  }
  throw new Error(
    `no sshd directory for port ${port} under the temporary directory`,
  );
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} did not exit`);
}

function visitTsFiles(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir)) {
    const file = join(dir, entry);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      visitTsFiles(file, visit);
    } else if (entry.endsWith(".ts")) {
      visit(file);
    }
  }
}

describe("test/helpers/remote/index.test", () => {
  const tools = resolveTools({});

  it("lists the two transports in bytewise order", () => {
    assert.deepEqual(fixtureTransports, ["http-basic", "ssh"]);
  });

  it("matches the deterministic tier of the proposal in both directions and pins the transport vocabulary", () => {
    const transportEvidence = {
      "http-basic": "git smart HTTP",
      ssh: "`sshd`",
    } as const;
    const line = fs
      .readFileSync(join(repoRoot, "docs/proposal/README.md"), "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith("- **`deterministic`**"));
    assert.ok(line !== undefined);

    assert.deepEqual(
      [...fixtureTransports].sort(),
      Object.keys(transportEvidence).sort(),
    );
    for (const phrase of Object.values(transportEvidence)) {
      assert.ok(line.includes(phrase));
    }

    const hits = new Set<string>();
    for (const match of line.matchAll(
      /\b(git|ssh|http|https|file|rsync)\b/gi,
    )) {
      const hit = match[0];
      assert.ok(hit !== undefined);
      hits.add(hit);
    }
    if (line.includes("sshd")) {
      hits.add("sshd");
    }
    const vocabulary = ["git", "HTTP", "ssh", "sshd"];
    assert.deepEqual([...hits].sort(), [...vocabulary].sort());
  });

  it("resolves the proposal doc and the grep roots from the file's own location, not process.cwd()", () => {
    const foreignCwd = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-foreign-cwd-"),
    );
    const previousCwd = process.cwd();
    process.chdir(foreignCwd);
    try {
      assert.ok(
        fs.existsSync(join(repoRoot, "docs/proposal/README.md")),
        "the proposal doc must resolve from the test file's own directory",
      );
      assert.ok(
        fs.existsSync(join(repoRoot, "src")),
        "the grep root must resolve from the test file's own directory",
      );
      assert.ok(
        fs.existsSync(join(repoRoot, "test")),
        "the grep root must resolve from the test file's own directory",
      );
      assert.equal(
        fs.existsSync("docs/proposal/README.md"),
        false,
        "a bare cwd-relative lookup must not accidentally resolve from the foreign cwd",
      );
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(foreignCwd, { recursive: true, force: true });
    }
  });

  it("createHttpRemote resolves to a live handle that serves the seeded commit", async () => {
    const remote = await createHttpRemote();
    after(() => remote.dispose());

    assert.equal(remote.transport, "http-basic");
    const out = await gitLsRemote(
      tools,
      remote.authenticatedUrl("fixture.git", remote.credentials.reader),
    );
    const commit2 = fixtureObjectIds.commit2;
    assert.ok(commit2 !== undefined);
    assert.ok(out.includes(commit2));
  });

  it("createSshRemote resolves to a live handle for the ssh transport", async () => {
    const remote = await createSshRemote();
    after(() => remote.dispose());

    assert.equal(remote.transport, "ssh");
  });

  it("withholds the HTTP handle when a forced check fails and closes its port", async () => {
    let capturedPort = 0;
    const forced = {
      name: "forced",
      run(subject: HttpRemote) {
        capturedPort = subject.port;
        throw new Error("forced failure");
      },
    };
    await assert.rejects(
      createHttpRemote({
        checks: [...httpAcceptanceChecks.slice(0, 3), forced],
      }),
      (error) => {
        if (!(error instanceof FixtureError)) return false;
        assert.deepEqual(error.failures, [
          { name: "forced", reason: "forced failure" },
        ]);
        return true;
      },
    );
    assert.ok(capturedPort > 0);
    await assertPortRefused(capturedPort);
  });

  it("withholds the ssh handle when a forced check fails and closes its port", async () => {
    let capturedPort = 0;
    const forced = {
      name: "forced",
      run(subject: SshRemote) {
        capturedPort = subject.port;
        throw new Error("forced failure");
      },
    };
    await assert.rejects(
      createSshRemote({ checks: [...sshAcceptanceChecks.slice(0, 2), forced] }),
      (error) => {
        if (!(error instanceof FixtureError)) return false;
        assert.deepEqual(error.failures, [
          { name: "forced", reason: "forced failure" },
        ]);
        return true;
      },
    );
    assert.ok(capturedPort > 0);
    await assertPortRefused(capturedPort);
  });

  it("createRemotes shares one seed between both transports", async () => {
    const remotes = await createRemotes();
    after(() => remotes.dispose());

    assert.equal(remotes.http.seed.path, remotes.ssh.seed.path);
  });

  it("createRemotes dispose closes both ports and removes the shared seed", async () => {
    const remotes = await createRemotes();
    const httpPort = remotes.http.port;
    const sshPort = remotes.ssh.port;
    const sharedPath = remotes.http.seed.path;

    await remotes.dispose();
    assert.equal(fs.existsSync(sharedPath), false);
    await assertPortRefused(httpPort);
    await assertPortRefused(sshPort);
  });

  it("a single-factory handle disposes the seed it owns", async () => {
    const httpRemote = await createHttpRemote();
    const httpSeedPath = httpRemote.seed.path;
    await httpRemote.dispose();
    assert.equal(fs.existsSync(httpSeedPath), false);

    const sshRemote = await createSshRemote();
    const sshSeedPath = sshRemote.seed.path;
    await sshRemote.dispose();
    assert.equal(fs.existsSync(sshSeedPath), false);
  });

  it("disposing one transport of createRemotes keeps the shared seed alive", async () => {
    const remotes = await createRemotes();
    const sharedPath = remotes.http.seed.path;

    await remotes.http.dispose();
    assert.equal(fs.existsSync(sharedPath), true);

    await remotes.dispose();
    assert.equal(fs.existsSync(sharedPath), false);
  });

  it("fails loudly with ToolError when a required tool is absent and leaks no temporary directory", async () => {
    const beforeHttp = tmpEntries();
    await assert.rejects(
      createHttpRemote({ env: { KANTHORD_TEST_GIT: "/nonexistent/git" } }),
      (error) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "git");
        return true;
      },
    );
    assert.deepEqual(tmpEntries(), beforeHttp);

    const beforeSsh = tmpEntries();
    await assert.rejects(
      createSshRemote({ env: { KANTHORD_TEST_SSHD: "/nonexistent/sshd" } }),
      (error) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "sshd");
        return true;
      },
    );
    assert.deepEqual(tmpEntries(), beforeSsh);
  });

  it("does not count a foreign kanthord temp directory as a leak of the failed factory", async () => {
    const before = tmpEntries().length;
    const foreign = fs.mkdtempSync(join(os.tmpdir(), "kanthord-foreign-"));
    after(() => fs.rmSync(foreign, { recursive: true, force: true }));

    await assert.rejects(
      createHttpRemote({ env: { KANTHORD_TEST_GIT: "/nonexistent/git" } }),
      (error) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "git");
        return true;
      },
    );
    assert.equal(tmpEntries().length, before + 1);
  });

  it("dispose keeps cleaning the shared seed when a transport disposal fails", async () => {
    const remotes = await createRemotes();
    const sharedPath = remotes.http.seed.path;
    const serverDirectory = findSshdDirectory(remotes.ssh.port);
    const pid = Number(
      fs.readFileSync(join(serverDirectory, "sshd.pid"), "utf8").trim(),
    );
    after(() => {
      fs.rmSync(serverDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
      fs.rmSync(sharedPath, { recursive: true, force: true });
    });

    process.kill(pid, "SIGKILL");
    await waitForProcessExit(pid);
    fs.chmodSync(serverDirectory, 0o000);
    try {
      await assert.rejects(remotes.dispose());
    } finally {
      fs.chmodSync(serverDirectory, 0o700);
    }

    const deadline = Date.now() + 2000;
    while (fs.existsSync(sharedPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(sharedPath), false);
  });

  it("a single-factory handle keeps releasing its own seed when the transport disposal fails", async () => {
    const remote = await createSshRemote();
    const seedPath = remote.seed.path;
    const serverDirectory = findSshdDirectory(remote.port);
    const pid = Number(
      fs.readFileSync(join(serverDirectory, "sshd.pid"), "utf8").trim(),
    );
    after(() => {
      fs.rmSync(serverDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
      fs.rmSync(seedPath, { recursive: true, force: true });
    });

    process.kill(pid, "SIGKILL");
    await waitForProcessExit(pid);
    fs.chmodSync(serverDirectory, 0o000);
    try {
      await assert.rejects(remote.dispose());
    } finally {
      fs.chmodSync(serverDirectory, 0o700);
    }

    const deadline = Date.now() + 2000;
    while (fs.existsSync(seedPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      fs.existsSync(seedPath),
      false,
      "createSshRemote's single-factory dispose skipped seed.dispose() when the ssh transport's own dispose() threw",
    );
  });

  it("does not re-export the unchecked starters from the barrel", async () => {
    const exports = Object.keys(await import("./index.ts"));
    for (const starter of ["start" + "HttpRemote", "start" + "SshRemote"]) {
      assert.equal(exports.includes(starter), false);
    }
  });

  it("keeps the unchecked starters out of every other consumer by a repo-wide grep", () => {
    const allowed = new Set([
      "test/helpers/remote/index.ts",
      "test/helpers/remote/http.ts",
      "test/helpers/remote/http.test.ts",
      "test/helpers/remote/ssh.ts",
      "test/helpers/remote/ssh.test.ts",
    ]);
    const starterNames = ["start" + "HttpRemote", "start" + "SshRemote"];
    const offenders: string[] = [];
    for (const root of ["src", "test"]) {
      visitTsFiles(join(repoRoot, root), (file) => {
        const content = fs.readFileSync(file, "utf8");
        const relative = file.slice(repoRoot.length + 1);
        if (
          starterNames.some((name) => content.includes(name)) &&
          !allowed.has(relative)
        ) {
          offenders.push(relative);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      "every other consumer must come through createHttpRemote or createSshRemote",
    );
  });
});
