import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startSshRemote, sshAcceptanceChecks } from "./ssh.ts";
import type { FixtureHostKey, SshRemote } from "./ssh.ts";
import {
  fixtureObjectIds,
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
  seedRepositories,
} from "./seed.ts";
import { resolveTools, toolTimeoutMilliseconds } from "./tools.ts";
import type { Tools } from "./tools.ts";

const spawnGuard = {
  timeout: toolTimeoutMilliseconds,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

const execGit = promisify(execFile);

function sshGitEnvironment(
  tools: Tools,
  sshCommandValue: string,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...pinnedGitEnvironment,
    PATH: tools.execPath,
    GIT_SSH_COMMAND: sshCommandValue,
    ...extra,
  };
}

function runGitSync(
  tools: Tools,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): string {
  return execFileSync(tools.paths.git, [...pinnedGitConfigArguments, ...args], {
    env,
    encoding: "utf8",
    ...spawnGuard,
  }).trim();
}

function failedStderr(error: unknown): string {
  return String((error as { stderr?: string }).stderr ?? "");
}

function stubbornSshdScript(): string {
  const body = [
    "process.on('SIGTERM', () => {});",
    "const fs = require('fs');",
    "const net = require('net');",
    "const args = process.argv.slice(1);",
    "let config = null;",
    "for (let i = 1; i < args.length; i += 1) {",
    "  if (args[i - 1] === '-f') config = args[i];",
    "}",
    "const contents = fs.readFileSync(config, 'utf8');",
    "const portMatch = /^Port (\\d+)$/m.exec(contents);",
    "const pidFileMatch = /^PidFile (.+)$/m.exec(contents);",
    "const port = Number(portMatch[1]);",
    "fs.writeFileSync(pidFileMatch[1], String(process.pid));",
    "net.createServer((socket) => socket.on('error', () => {})).listen(port, '127.0.0.1');",
    "",
  ].join("\n");
  return `#!${process.execPath}\n${body}`;
}

async function pollUntilDead(
  pid: number,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
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

async function killMarkedSshd(marker: string): Promise<void> {
  const targets: { directory: string; pid: number | null }[] = [];
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith("kanthord-sshd-")) {
      continue;
    }
    const directory = join(os.tmpdir(), entry);
    if (!fs.existsSync(join(directory, marker))) {
      continue;
    }
    const pidPath = join(directory, "sshd.pid");
    let pid: number | null = null;
    if (fs.existsSync(pidPath)) {
      const candidate = Number(fs.readFileSync(pidPath, "utf8").trim());
      if (Number.isInteger(candidate) && candidate > 0) {
        pid = candidate;
      }
    } else {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && pid === null) {
        if (fs.existsSync(pidPath)) {
          const candidate = Number(fs.readFileSync(pidPath, "utf8").trim());
          if (Number.isInteger(candidate) && candidate > 0) {
            pid = candidate;
          }
        }
        if (pid === null) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    targets.push({ directory, pid });
  }
  for (const target of targets) {
    if (target.pid !== null) {
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }
  const deadline = Date.now() + 2000;
  for (const target of targets) {
    if (target.pid === null) {
      continue;
    }
    while (Date.now() < deadline) {
      try {
        process.kill(target.pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  for (const target of targets) {
    fs.rmSync(target.directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
}

function refsOf(
  tools: Tools,
  dir: string,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const line of runGitSync(
    tools,
    ["-C", dir, "for-each-ref", "--format=%(refname) %(objectname)"],
    env,
  ).split("\n")) {
    if (line === "") {
      continue;
    }
    const [name, objectName] = line.split(" ");
    assert.ok(name !== undefined);
    assert.ok(objectName !== undefined);
    refs[name] = objectName;
  }
  return refs;
}

describe("test/helpers/remote/ssh.test", () => {
  const tools = resolveTools({});

  it("reports a loopback port above 1024 and the invoking username", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    assert.ok(remote.port > 1024);
    assert.equal(remote.username, os.userInfo().username);
  });

  it("sorts host keys bytewise with ssh-ed25519 before ssh-rsa", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    assert.equal(remote.hostKeys.length, 2);
    assert.deepEqual(
      remote.hostKeys.map((key) => key.algorithm),
      ["ssh-ed25519", "ssh-rsa"],
    );
  });

  it("formats fingerprints as SHA256 and public keys as whitespace-free base64", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    for (const key of remote.hostKeys) {
      assert.ok(key.fingerprint.startsWith("SHA256:"));
      assert.match(key.publicKey, /^[A-Za-z0-9+/]+=*$/);
    }
  });

  it("spells knownHostsLine with the bracketed host and the algorithm", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const first = remote.hostKeys[0];
    assert.ok(first !== undefined);
    assert.ok(
      remote
        .knownHostsLine(first)
        .startsWith(`[127.0.0.1]:${remote.port} ssh-ed25519 `),
    );
  });

  it("fetches refs/remotes/origin/main at the commit2 literal with no local heads or tags", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const knownHosts = remote.writeKnownHosts(remote.hostKeys);
    const env = sshGitEnvironment(tools, remote.sshCommand({ knownHosts }));
    const client = fs.mkdtempSync(join(os.tmpdir(), "kanthord-ssh-client-"));
    after(() => fs.rmSync(client, { recursive: true, force: true }));

    runGitSync(tools, ["init", "--template=", client], env);
    runGitSync(
      tools,
      ["-C", client, "remote", "add", "origin", remote.url("fixture.git")],
      env,
    );
    runGitSync(
      tools,
      [
        "-C",
        client,
        "fetch",
        "--no-tags",
        "--prune",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      env,
    );

    const refs = refsOf(tools, client, env);
    assert.equal(refs["refs/remotes/origin/main"], fixtureObjectIds.commit2);
    assert.equal(
      Object.keys(refs).some((name) => /^refs\/heads\//.test(name)),
      false,
    );
    assert.equal(
      Object.keys(refs).some((name) => /^refs\/tags\//.test(name)),
      false,
    );
  });

  it("matches the bytewise-sorted ssh-keyscan output against the handle host keys", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const output = execFileSync(
      tools.paths.sshKeyscan,
      ["-p", String(remote.port), "127.0.0.1"],
      {
        env: { PATH: tools.execPath, LC_ALL: "C" },
        encoding: "utf8",
        ...spawnGuard,
      },
    );
    const scanned: { algorithm: string; publicKey: string }[] = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }
      const tokens = trimmed.split(/\s+/);
      const algorithm = tokens[tokens.length - 2];
      const publicKey = tokens[tokens.length - 1];
      if (algorithm === undefined || publicKey === undefined) {
        continue;
      }
      scanned.push({ algorithm, publicKey });
    }

    const sortedAlgorithms = scanned
      .map((key) => key.algorithm)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(sortedAlgorithms, ["ssh-ed25519", "ssh-rsa"]);

    const scannedKeys = scanned
      .map((key) => key.publicKey)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const handleKeys = remote.hostKeys
      .map((key) => key.publicKey)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(scannedKeys, handleKeys);
  });

  it("refuses a mismatched host key, names the offered fingerprint, and fails fast", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const knownHosts = remote.writeKnownHosts([remote.wrongHostKey]);
    const env = sshGitEnvironment(tools, remote.sshCommand({ knownHosts }));

    const started = Date.now();
    let stderr = "";
    let failed = false;
    try {
      runGitSync(tools, ["ls-remote", remote.url("fixture.git")], env);
    } catch (error) {
      failed = true;
      stderr = failedStderr(error);
    }
    const elapsed = Date.now() - started;

    assert.equal(failed, true);
    assert.ok(stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED"));
    const offered = remote.hostKeys[0];
    assert.ok(offered !== undefined);
    assert.ok(stderr.includes(offered.fingerprint));
    assert.ok(!stderr.includes(remote.wrongHostKey.fingerprint));
    assert.ok(elapsed < 5000);
  });

  it("refuses a private key that is not mode 0600", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const knownHosts = remote.writeKnownHosts(remote.hostKeys);
    const leakDir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-ssh-key-"));
    after(() => fs.rmSync(leakDir, { recursive: true, force: true }));
    const badKeyPath = join(leakDir, "client");
    fs.copyFileSync(remote.privateKeyPath, badKeyPath);
    fs.chmodSync(badKeyPath, 0o644);

    const env = sshGitEnvironment(
      tools,
      remote.sshCommand({ knownHosts, privateKey: badKeyPath }),
    );
    let stderr = "";
    let failed = false;
    try {
      runGitSync(tools, ["ls-remote", remote.url("fixture.git")], env);
    } catch (error) {
      failed = true;
      stderr = failedStderr(error);
    }
    assert.equal(failed, true);
    assert.ok(stderr.includes("UNPROTECTED PRIVATE KEY FILE"));
    assert.ok(stderr.includes("Permission denied (publickey)"));
  });

  it("ignores a hostile HOME ssh config under -F /dev/null and runs the same trap only when -F selects it", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const hostileHome = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-ssh-hostile-"),
    );
    after(() => fs.rmSync(hostileHome, { recursive: true, force: true }));
    fs.mkdirSync(join(hostileHome, ".ssh"), { recursive: true });
    fs.writeFileSync(
      join(hostileHome, ".ssh", "config"),
      "Host *\n  ProxyCommand /bin/sh -c 'echo hostile-proxy-ran >&2; exit 47'\n",
    );

    const knownHosts = remote.writeKnownHosts(remote.hostKeys);
    const pinnedEnv = sshGitEnvironment(
      tools,
      remote.sshCommand({ knownHosts }),
      {
        HOME: hostileHome,
      },
    );
    const pinned = spawnSync(
      tools.paths.git,
      [...pinnedGitConfigArguments, "ls-remote", remote.url("fixture.git")],
      { env: pinnedEnv, encoding: "utf8", ...spawnGuard },
    );
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.ok(!(pinned.stderr ?? "").includes("hostile-proxy-ran"));

    const hostileConfig = join(hostileHome, ".ssh", "config");
    const controlCommand = remote
      .sshCommand({ knownHosts })
      .replace(" -F /dev/null", ` -F '${hostileConfig}'`);
    const controlEnv = sshGitEnvironment(tools, controlCommand, {
      HOME: hostileHome,
    });
    const control = spawnSync(
      tools.paths.git,
      [...pinnedGitConfigArguments, "ls-remote", remote.url("fixture.git")],
      { env: controlEnv, encoding: "utf8", ...spawnGuard },
    );
    assert.notEqual(control.status, 0);
    assert.ok((control.stderr ?? "").includes("hostile-proxy-ran"));
  });

  it("resolves no proxycommand for the pinned -F selection and resolves the trap for the hostile one, via ssh -G", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const hostileHome = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-ssh-hostile-g-"),
    );
    after(() => fs.rmSync(hostileHome, { recursive: true, force: true }));
    fs.mkdirSync(join(hostileHome, ".ssh"), { recursive: true });
    const hostileConfig = join(hostileHome, ".ssh", "config");
    fs.writeFileSync(
      hostileConfig,
      "Host *\n  ProxyCommand /bin/sh -c 'echo hostile-proxy-ran >&2; exit 47'\n",
    );

    const knownHosts = remote.writeKnownHosts(remote.hostKeys);
    const command = remote.sshCommand({ knownHosts });

    const binaryMatch = /^'([^']*)'/.exec(command);
    assert.ok(
      binaryMatch !== null,
      `sshCommand does not start with a quoted ssh binary: ${command}`,
    );
    const sshBinary = (binaryMatch as RegExpExecArray)[1] as string;

    const flagMatch = /(?:^|\s)-F (\S+)/.exec(command);
    assert.ok(
      flagMatch !== null,
      `sshCommand carries no -F flag to derive: ${command}`,
    );
    const pinnedFlagValue = (flagMatch as RegExpExecArray)[1] as string;

    const pinnedProbe = spawnSync(
      sshBinary,
      ["-G", "-F", pinnedFlagValue, "127.0.0.1"],
      { env: { HOME: hostileHome }, encoding: "utf8", ...spawnGuard },
    );
    assert.equal(pinnedProbe.status, 0, pinnedProbe.stderr);
    assert.ok(!/^proxycommand /im.test(pinnedProbe.stdout ?? ""));

    const hostileProbe = spawnSync(
      sshBinary,
      ["-G", "-F", hostileConfig, "127.0.0.1"],
      { env: { HOME: hostileHome }, encoding: "utf8", ...spawnGuard },
    );
    assert.equal(hostileProbe.status, 0, hostileProbe.stderr);
    assert.ok(/^proxycommand /im.test(hostileProbe.stdout ?? ""));
  });

  it("keeps ssh away from a trap SSH_AUTH_SOCK and proves the trap reachable by answering the agent protocol", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const agentDir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-agent-"));
    after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
    const socketPath = join(agentDir, "agent.sock");
    let agentConnections = 0;
    const agentServer = net.createServer((socket) => {
      agentConnections += 1;
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        if (chunk[4] === 0x0b) {
          socket.write(Buffer.from([0, 0, 0, 5, 0x0c, 0, 0, 0, 0]));
        } else {
          socket.write(Buffer.from([0, 0, 0, 1, 0x04]));
        }
        socket.end();
      });
    });
    await new Promise<void>((resolve) => {
      agentServer.listen(socketPath, resolve);
    });
    after(() => {
      agentServer.close();
    });

    const knownHosts = remote.writeKnownHosts(remote.hostKeys);
    const pinnedEnv = sshGitEnvironment(
      tools,
      remote.sshCommand({ knownHosts }),
      {
        SSH_AUTH_SOCK: socketPath,
      },
    );
    const commit2 = fixtureObjectIds.commit2;
    assert.ok(commit2 !== undefined);
    const { stdout } = await execGit(
      tools.paths.git,
      [...pinnedGitConfigArguments, "ls-remote", remote.url("fixture.git")],
      { env: pinnedEnv, encoding: "utf8", ...spawnGuard },
    );
    assert.ok(stdout.toString().includes(commit2));
    assert.equal(agentConnections, 0);

    const controlCommand = remote
      .sshCommand({ knownHosts })
      .replace(" -o IdentityAgent=none", "")
      .replace("IdentitiesOnly=yes", "IdentitiesOnly=no");
    const controlEnv = sshGitEnvironment(tools, controlCommand, {
      SSH_AUTH_SOCK: socketPath,
    });
    const control = await execGit(
      tools.paths.git,
      [...pinnedGitConfigArguments, "ls-remote", remote.url("fixture.git")],
      { env: controlEnv, encoding: "utf8", ...spawnGuard },
    );
    assert.ok(control.stdout.toString().includes(commit2));
    assert.ok(agentConnections > 0);
  });

  it("exports the three acceptance checks with the exact names in order", () => {
    assert.equal(sshAcceptanceChecks.length, 3);
    assert.deepEqual(
      sshAcceptanceChecks.map((check) => check.name),
      [
        "ssh: key-authenticated fetch",
        "ssh: refuses a mismatched host key",
        "ssh: refuses a key file that is not mode 0600",
      ],
    );
  });

  it("passes every acceptance check against a live handle", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    for (const check of sshAcceptanceChecks) {
      await check.run(remote);
    }
  });

  it("dispose removes the server directory and the port refuses connections afterwards", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);

    const serverDirectory = findSshdDirectory(remote.port);
    await remote.dispose();
    assert.equal(fs.existsSync(serverDirectory), false);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(remote.port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        reject(
          new Error("the disposed fixture port still accepts connections"),
        );
      });
      socket.once("error", () => {
        socket.destroy();
        resolve();
      });
    });
  });

  it("logs the accepted publickey and pins the SetEnv PATH directive in sshd_config", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const remote = await startSshRemote(tools, seed);
    after(() => remote.dispose());

    const knownHosts = remote.writeKnownHosts(remote.hostKeys);
    const env = sshGitEnvironment(tools, remote.sshCommand({ knownHosts }));
    runGitSync(tools, ["ls-remote", remote.url("fixture.git")], env);

    assert.ok(remote.log().includes("Accepted publickey for"));
    const configPath = join(findSshdDirectory(remote.port), "sshd_config");
    const config = fs.readFileSync(configPath, "utf8");
    assert.ok(config.includes(`SetEnv PATH=${tools.execPath}`));
  });

  it("succeeds when the first sshd attempt fails and the second one starts", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const work = fs.mkdtempSync(join(os.tmpdir(), "kanthord-ssh-retry-"));
    after(() => fs.rmSync(work, { recursive: true, force: true }));

    const marker = ".kanthord-retry-marker";
    const wrapper = join(work, "sshd");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ ! -e "$0.first" ]; then /usr/bin/touch "$0.first"; exit 1; fi\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-f" ]; then /usr/bin/touch "$(/usr/bin/dirname "$a")/${marker}"; fi\n  prev="$a"\ndone\n( /bin/sleep 5; /bin/kill -9 $$ ) >/dev/null 2>&1 &\nexec ${tools.paths.sshd} "$@"\n`,
      { mode: 0o755 },
    );
    const retryTools = { ...tools, paths: { ...tools.paths, sshd: wrapper } };

    let remote: SshRemote | null = null;
    try {
      remote = await startSshRemote(retryTools, seed);
    } catch (error) {
      await killMarkedSshd(marker);
      throw error;
    }
    after(() => remote?.dispose());
    after(() => killMarkedSshd(marker));

    assert.ok(remote !== null);
    assert.ok(remote.port > 1024);
  });

  it("cleans its server directory when sshd fails to start on every attempt", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const work = fs.mkdtempSync(join(os.tmpdir(), "kanthord-ssh-dead-"));
    after(() => fs.rmSync(work, { recursive: true, force: true }));

    const marker = ".kanthord-dead-marker";
    const stub = join(work, "sshd");
    fs.writeFileSync(
      stub,
      `#!/bin/sh\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-f" ]; then /usr/bin/touch "$(/usr/bin/dirname "$a")/${marker}" 2>/dev/null; fi\n  prev="$a"\ndone\nexit 1\n`,
      { mode: 0o755 },
    );
    const deadTools = { ...tools, paths: { ...tools.paths, sshd: stub } };

    const markerPresent = (): boolean => {
      for (const entry of fs.readdirSync(os.tmpdir())) {
        if (!entry.startsWith("kanthord-sshd-")) {
          continue;
        }
        if (fs.existsSync(join(os.tmpdir(), entry, marker))) {
          return true;
        }
      }
      return false;
    };
    after(() => killMarkedSshd(marker));

    await assert.rejects(startSshRemote(deadTools, seed));

    const deadline = Date.now() + 2000;
    while (markerPresent() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(markerPresent(), false);
  });

  it("dispose escalates to SIGKILL, confirms exit and removes the directory when sshd ignores SIGTERM", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const work = fs.mkdtempSync(join(os.tmpdir(), "kanthord-ssh-stubborn-"));
    after(() => fs.rmSync(work, { recursive: true, force: true }));

    const stub = join(work, "sshd");
    fs.writeFileSync(stub, stubbornSshdScript(), {
      mode: 0o755,
    });
    const stubbornTools = { ...tools, paths: { ...tools.paths, sshd: stub } };

    const remote = await startSshRemote(stubbornTools, seed);
    const serverDirectory = findSshdDirectory(remote.port);
    const pidPath = join(serverDirectory, "sshd.pid");

    after(async () => {
      if (fs.existsSync(pidPath)) {
        const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already dead
          }
          await pollUntilDead(pid, 2000);
        }
      }
      fs.rmSync(serverDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    });

    const disposeCall = remote.dispose();
    disposeCall.catch(() => undefined);

    const started = Date.now();
    const outcome = await Promise.race([
      disposeCall.then(
        () => "disposed" as const,
        () => "disposed-with-error" as const,
      ),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 9000),
      ),
    ]);
    const elapsed = Date.now() - started;

    assert.equal(
      outcome,
      "disposed",
      `dispose did not settle within 9000ms against a SIGTERM-ignoring daemon (elapsed ${elapsed}ms)`,
    );
    assert.equal(fs.existsSync(serverDirectory), false);
  });

  it("rejects quickly and names the spawn failure when sshd cannot be spawned at all", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const missingTools = {
      ...tools,
      paths: {
        ...tools.paths,
        sshd: join(os.tmpdir(), "kanthord-sshd-does-not-exist-anywhere"),
      },
    };

    const started = Date.now();
    await assert.rejects(startSshRemote(missingTools, seed), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes("ENOENT"),
        `expected the spawn-failure rejection to name ENOENT, got: ${error.message}`,
      );
      return true;
    });
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < 5000,
      `startSshRemote took ${elapsed}ms to report a spawn failure instead of reacting to the child's "error" event`,
    );
  });

  it("kills the sshd fixture on process exit even when the harness that started it never disposes it", async () => {
    const work = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-ssh-exit-harness-"),
    );
    after(() => fs.rmSync(work, { recursive: true, force: true }));
    const markerPath = join(work, "port");
    const scriptPath = join(work, "harness.ts");
    fs.writeFileSync(
      scriptPath,
      [
        `import { startSshRemote } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "ssh.ts")).href)};`,
        `import { seedRepositories } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "seed.ts")).href)};`,
        `import { resolveTools } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "tools.ts")).href)};`,
        `import fs from "node:fs";`,
        `const tools = resolveTools({});`,
        `const seed = seedRepositories(tools);`,
        `const remote = await startSshRemote(tools, seed);`,
        `fs.writeFileSync(${JSON.stringify(markerPath)}, String(remote.port));`,
        `seed.dispose();`,
        `process.exit(0);`,
        "",
      ].join("\n"),
    );

    execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      timeout: toolTimeoutMilliseconds,
      killSignal: "SIGKILL",
    });

    const port = Number(fs.readFileSync(markerPath, "utf8").trim());
    assert.ok(Number.isInteger(port) && port > 0);
    const serverDirectory = findSshdDirectory(port);
    const pidPath = join(serverDirectory, "sshd.pid");

    let pid: number | null = null;
    const pidDeadline = Date.now() + 2000;
    while (pid === null && Date.now() < pidDeadline) {
      if (fs.existsSync(pidPath)) {
        const candidate = Number(fs.readFileSync(pidPath, "utf8").trim());
        if (Number.isInteger(candidate) && candidate > 0) {
          pid = candidate;
        }
      }
      if (pid === null) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(pid !== null, "the harness's sshd never wrote a pid file");

    after(async () => {
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      fs.rmSync(serverDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    });

    const died = await pollUntilDead(pid as number, 2000);
    assert.ok(
      died,
      `pid ${pid} (the harness's undisposed sshd fixture) was still alive ${2000}ms after the harness process that started it exited without calling dispose()`,
    );
  });

  it("lets a harness that never disposed the fixture exit on its own instead of hanging", async () => {
    const work = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-ssh-natural-exit-"),
    );
    after(() => fs.rmSync(work, { recursive: true, force: true }));
    const markerPath = join(work, "port");
    const scriptPath = join(work, "harness.ts");
    fs.writeFileSync(
      scriptPath,
      [
        `import { startSshRemote } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "ssh.ts")).href)};`,
        `import { seedRepositories } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "seed.ts")).href)};`,
        `import { resolveTools } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "tools.ts")).href)};`,
        `import fs from "node:fs";`,
        `const tools = resolveTools({});`,
        `const seed = seedRepositories(tools);`,
        `const remote = await startSshRemote(tools, seed);`,
        `fs.writeFileSync(${JSON.stringify(markerPath)}, String(remote.port));`,
        `seed.dispose();`,
        "",
      ].join("\n"),
    );

    const harnessDeadline = 15000;
    const started = Date.now();
    const harness = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      timeout: harnessDeadline,
      killSignal: "SIGKILL",
    });
    const elapsed = Date.now() - started;

    const port = Number(fs.readFileSync(markerPath, "utf8").trim());
    assert.ok(Number.isInteger(port) && port > 0);
    const serverDirectory = findSshdDirectory(port);
    const pidPath = join(serverDirectory, "sshd.pid");
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
      fs.rmSync(serverDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    });

    assert.equal(
      harness.signal,
      null,
      `the harness had to be killed after ${elapsed}ms: a live fixture kept the event loop open, so a file whose tests all passed would never exit`,
    );
    assert.equal(harness.status, 0, harness.stderr);
    assert.ok(elapsed < harnessDeadline);

    const died = await pollUntilDead(pid, 2000);
    assert.ok(
      died,
      `pid ${pid} survived the harness's natural exit, so the emergency kill did not fire`,
    );
  });

  it("keeps the emergency-registry entry live when disposal could not confirm the daemon exited", async () => {
    const work = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-ssh-registry-harness-"),
    );
    after(() => fs.rmSync(work, { recursive: true, force: true }));
    const markerPath = join(work, "pid");
    const scriptPath = join(work, "harness.ts");
    fs.writeFileSync(
      scriptPath,
      [
        `import { startSshRemote } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "ssh.ts")).href)};`,
        `import { seedRepositories } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "seed.ts")).href)};`,
        `import { resolveTools } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "tools.ts")).href)};`,
        `import { ChildProcess } from "node:child_process";`,
        `import fs from "node:fs";`,
        `import os from "node:os";`,
        `import { join } from "node:path";`,
        `const tools = resolveTools({});`,
        `const seed = seedRepositories(tools);`,
        `const remote = await startSshRemote(tools, seed);`,
        `let serverDirectory = null;`,
        `for (const entry of fs.readdirSync(os.tmpdir())) {`,
        `  if (!entry.startsWith("kanthord-sshd-")) continue;`,
        `  const configPath = join(os.tmpdir(), entry, "sshd_config");`,
        `  if (!fs.existsSync(configPath)) continue;`,
        `  if (fs.readFileSync(configPath, "utf8").includes("Port " + remote.port)) {`,
        `    serverDirectory = join(os.tmpdir(), entry);`,
        `  }`,
        `}`,
        `if (serverDirectory === null) throw new Error("harness could not find its own sshd directory");`,
        `const pid = fs.readFileSync(join(serverDirectory, "sshd.pid"), "utf8").trim();`,
        `fs.writeFileSync(${JSON.stringify(markerPath)}, pid);`,
        `const originalKill = ChildProcess.prototype.kill;`,
        `ChildProcess.prototype.kill = function () { return true; };`,
        `try {`,
        `  await remote.dispose();`,
        `} catch {`,
        `  // expected: the neutered kill means dispose can never confirm the daemon exited`,
        `}`,
        `ChildProcess.prototype.kill = originalKill;`,
        `seed.dispose();`,
        `process.exit(0);`,
        "",
      ].join("\n"),
    );

    execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      timeout: toolTimeoutMilliseconds + 8000,
      killSignal: "SIGKILL",
    });

    const pid = Number(fs.readFileSync(markerPath, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0);

    after(async () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    });

    const died = await pollUntilDead(pid, 3000);
    assert.ok(
      died,
      `pid ${pid} was still alive 3000ms after the harness process exited; the daemon's dispose() could not confirm the exit (kill was neutered throughout), so the emergency-kill registry must have kept the entry and killed it for real once kill was restored and the harness exited — this fails when the registry is cleared unconditionally regardless of a confirmed exit`,
    );
  });

  it("removes the server directory when key generation throws before any sshd attempt starts", async () => {
    const seed = seedRepositories(tools);
    after(() => seed.dispose());
    const work = fs.mkdtempSync(
      join(os.tmpdir(), "kanthord-ssh-keygen-throws-"),
    );
    after(() => fs.rmSync(work, { recursive: true, force: true }));

    const brokenKeygen = join(work, "ssh-keygen");
    fs.writeFileSync(brokenKeygen, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const brokenTools = {
      ...tools,
      paths: { ...tools.paths, sshKeygen: brokenKeygen },
    };

    const before = fs
      .readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith("kanthord-sshd-"))
      .sort();

    await assert.rejects(startSshRemote(brokenTools, seed));

    const after1 = fs
      .readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith("kanthord-sshd-"))
      .sort();
    assert.deepEqual(
      after1,
      before,
      `startSshRemote leaked a kanthord-sshd-* directory when ssh-keygen failed before any sshd attempt: before=${JSON.stringify(before)} after=${JSON.stringify(after1)}`,
    );
  });
});
