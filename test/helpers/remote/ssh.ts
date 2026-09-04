import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTools, toolTimeoutMilliseconds } from "./tools.ts";
import type { Tools } from "./tools.ts";
import {
  fixtureObjectIds,
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
} from "./seed.ts";
import type { SeedRoot } from "./seed.ts";

export type FixtureHostKey = Readonly<{
  algorithm: string;
  publicKey: string;
  fingerprint: string;
}>;

export type SshRemote = Readonly<{
  transport: "ssh";
  port: number;
  username: string;
  hostKeys: readonly FixtureHostKey[];
  privateKeyPath: string;
  wrongHostKey: FixtureHostKey;
  knownHostsLine(hostKey: FixtureHostKey): string;
  writeKnownHosts(hostKeys: readonly FixtureHostKey[]): string;
  sshCommand(
    input: Readonly<{ knownHosts: string; privateKey?: string }>,
  ): string;
  url(repository: string): string;
  seed: SeedRoot;
  log(): string;
  dispose(): Promise<void>;
}>;

const spawnGuard = {
  timeout: toolTimeoutMilliseconds,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
} as const;

function quote(path: string): string {
  if (path.includes("'")) {
    throw new Error(
      `ssh fixture refuses a path containing a single quote: ${path}`,
    );
  }
  return `'${path}'`;
}

function generateKey(
  tools: Tools,
  keyPath: string,
  args: readonly string[],
): void {
  execFileSync(tools.paths.sshKeygen, [...args, "-N", "", "-f", keyPath], {
    env: {},
    encoding: "utf8",
    ...spawnGuard,
  });
  fs.chmodSync(keyPath, 0o600);
}

function readPublicKey(
  publicKeyPath: string,
): Readonly<{ algorithm: string; publicKey: string }> {
  const tokens = fs.readFileSync(publicKeyPath, "utf8").trim().split(/\s+/);
  const algorithm = tokens[0];
  const publicKey = tokens[1];
  if (algorithm === undefined || publicKey === undefined) {
    throw new Error(`ssh fixture: unparseable public key at ${publicKeyPath}`);
  }
  return { algorithm, publicKey };
}

function keyFingerprint(tools: Tools, publicKeyPath: string): string {
  const output = execFileSync(
    tools.paths.sshKeygen,
    ["-l", "-f", publicKeyPath],
    { env: {}, encoding: "utf8", ...spawnGuard },
  ).trim();
  const fingerprint = output.split(/\s+/)[1];
  if (fingerprint === undefined || !fingerprint.startsWith("SHA256:")) {
    throw new Error(`ssh fixture: unparseable key fingerprint: ${output}`);
  }
  return fingerprint;
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(
            new Error("ssh fixture: loopback reserve has no numeric address"),
          );
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function writeSshdConfig(
  configPath: string,
  port: number,
  serverDirectory: string,
  tools: Tools,
): void {
  const directives = [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${join(serverDirectory, "host_ed25519")}`,
    `HostKey ${join(serverDirectory, "host_rsa")}`,
    `PidFile ${join(serverDirectory, "sshd.pid")}`,
    `AuthorizedKeysFile ${join(serverDirectory, "authorized_keys")}`,
    "StrictModes no",
    "UsePAM no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "PermitUserEnvironment no",
    "AllowAgentForwarding no",
    "AllowTcpForwarding no",
    "X11Forwarding no",
    "PerSourcePenalties no",
    "LogLevel VERBOSE",
    "Subsystem sftp internal-sftp",
    `SetEnv PATH=${tools.execPath}`,
  ];
  fs.writeFileSync(configPath, directives.join("\n") + "\n");
}

function logTail(logPath: string): string {
  try {
    return fs.readFileSync(logPath, "utf8").split("\n").slice(-10).join("\n");
  } catch {
    return "(no log file)";
  }
}

function removeServerDirectory(serverDirectory: string): void {
  fs.rmSync(serverDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

function waitForListener(
  port: number,
  logPath: string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 5000;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    child.once("exit", (code) => {
      finish(
        new Error(
          `sshd exited with code ${String(code)} before listening on port ${port}; log tail: ${logTail(logPath)}`,
        ),
      );
    });
    child.once("error", (error) => {
      finish(
        new Error(
          `sshd failed to spawn before listening on port ${port}: ${error.message}; log tail: ${logTail(logPath)}`,
        ),
      );
    });
    const attempt = (): void => {
      if (settled) {
        return;
      }
      if (Date.now() >= deadline) {
        finish(
          new Error(
            `sshd fixture did not accept a connection on port ${port} within 5000 ms; log tail: ${logTail(logPath)}`,
          ),
        );
        return;
      }
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        finish(null);
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

const disposeGraceMilliseconds = 2000;
const disposeKillMilliseconds = 3000;

function waitForExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMilliseconds);
    child.once("exit", onExit);
  });
}

const liveSshdRegistry = new Set<ChildProcess>();
let emergencyKillRegistered = false;

function registerEmergencyKill(): void {
  if (emergencyKillRegistered) {
    return;
  }
  emergencyKillRegistered = true;
  process.on("exit", () => {
    for (const child of liveSshdRegistry) {
      try {
        child.kill("SIGKILL");
      } catch {
        // the runner is already exiting; a failed kill leaves nothing more to do
      }
    }
  });
}

registerEmergencyKill();

function runGit(
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

function sshGitEnvironment(
  tools: Tools,
  sshCommandValue: string,
): Record<string, string> {
  return {
    ...pinnedGitEnvironment,
    PATH: tools.execPath,
    GIT_SSH_COMMAND: sshCommandValue,
  };
}

function failedStderr(error: unknown): string {
  return String((error as { stderr?: string }).stderr ?? "");
}

export const sshAcceptanceChecks: readonly {
  name: string;
  run(subject: SshRemote): Promise<void> | void;
}[] = [
  {
    name: "ssh: key-authenticated fetch",
    async run(subject) {
      const tools = resolveTools({});
      const knownHosts = subject.writeKnownHosts(subject.hostKeys);
      const output = runGit(
        tools,
        ["ls-remote", subject.url("fixture.git")],
        sshGitEnvironment(tools, subject.sshCommand({ knownHosts })),
      );
      if (!output.includes(`${fixtureObjectIds.commit2}\trefs/heads/main`)) {
        throw new Error(
          "ssh acceptance: key-authenticated ls-remote did not report refs/heads/main at the commit2 literal",
        );
      }
    },
  },
  {
    name: "ssh: refuses a mismatched host key",
    async run(subject) {
      const tools = resolveTools({});
      const knownHosts = subject.writeKnownHosts([subject.wrongHostKey]);
      let failed = false;
      let stderr = "";
      try {
        runGit(
          tools,
          ["ls-remote", subject.url("fixture.git")],
          sshGitEnvironment(tools, subject.sshCommand({ knownHosts })),
        );
      } catch (error) {
        failed = true;
        stderr = failedStderr(error);
      }
      if (!failed) {
        throw new Error(
          "ssh acceptance: a mismatched pinned host key was accepted",
        );
      }
      if (!stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")) {
        throw new Error(
          "ssh acceptance: the mismatch refusal did not name REMOTE HOST IDENTIFICATION HAS CHANGED",
        );
      }
    },
  },
  {
    name: "ssh: refuses a key file that is not mode 0600",
    async run(subject) {
      const tools = resolveTools({});
      const dir = fs.mkdtempSync(join(tmpdir(), "kanthord-ssh-accept-"));
      try {
        const badKey = join(dir, "client");
        fs.copyFileSync(subject.privateKeyPath, badKey);
        fs.chmodSync(badKey, 0o644);
        const knownHosts = subject.writeKnownHosts(subject.hostKeys);
        let failed = false;
        let stderr = "";
        try {
          runGit(
            tools,
            ["ls-remote", subject.url("fixture.git")],
            sshGitEnvironment(
              tools,
              subject.sshCommand({ knownHosts, privateKey: badKey }),
            ),
          );
        } catch (error) {
          failed = true;
          stderr = failedStderr(error);
        }
        if (!failed) {
          throw new Error("ssh acceptance: a 0644 private key was accepted");
        }
        if (!stderr.includes("UNPROTECTED PRIVATE KEY FILE")) {
          throw new Error(
            "ssh acceptance: the 0644 refusal did not name UNPROTECTED PRIVATE KEY FILE",
          );
        }
        if (!stderr.includes("Permission denied (publickey)")) {
          throw new Error(
            "ssh acceptance: the 0644 refusal did not report Permission denied (publickey)",
          );
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

export async function startSshRemote(
  tools: Tools,
  seed: SeedRoot,
): Promise<SshRemote> {
  const serverDirectory = fs.mkdtempSync(join(tmpdir(), "kanthord-sshd-"));

  const hostEd25519Path = join(serverDirectory, "host_ed25519");
  const hostRsaPath = join(serverDirectory, "host_rsa");
  const clientKeyPath = join(serverDirectory, "client");
  const wrongKeyPath = join(serverDirectory, "wrong_ed25519");
  const authorizedKeysPath = join(serverDirectory, "authorized_keys");
  const configPath = join(serverDirectory, "sshd_config");
  const logPath = join(serverDirectory, "sshd.log");

  let hostKeys: FixtureHostKey[];
  let wrongHostKey: FixtureHostKey;
  try {
    fs.chmodSync(serverDirectory, 0o700);
    generateKey(tools, hostEd25519Path, ["-t", "ed25519"]);
    generateKey(tools, hostRsaPath, ["-t", "rsa", "-b", "2048"]);
    generateKey(tools, clientKeyPath, ["-t", "ed25519"]);
    generateKey(tools, wrongKeyPath, ["-t", "ed25519"]);
    fs.copyFileSync(`${clientKeyPath}.pub`, authorizedKeysPath);
    fs.chmodSync(authorizedKeysPath, 0o600);

    const hostKeyEntries: FixtureHostKey[] = [
      {
        ...readPublicKey(`${hostEd25519Path}.pub`),
        fingerprint: keyFingerprint(tools, `${hostEd25519Path}.pub`),
      },
      {
        ...readPublicKey(`${hostRsaPath}.pub`),
        fingerprint: keyFingerprint(tools, `${hostRsaPath}.pub`),
      },
    ];
    hostKeyEntries.sort((a, b) =>
      Buffer.compare(Buffer.from(a.algorithm), Buffer.from(b.algorithm)),
    );
    hostKeys = hostKeyEntries;

    const wrongPublic = readPublicKey(`${wrongKeyPath}.pub`);
    wrongHostKey = {
      algorithm: wrongPublic.algorithm,
      publicKey: wrongPublic.publicKey,
      fingerprint: keyFingerprint(tools, `${wrongKeyPath}.pub`),
    };
  } catch (error) {
    removeServerDirectory(serverDirectory);
    throw error;
  }

  let sshd: ChildProcess | null = null;
  let port = 0;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    port = await reserveLoopbackPort();
    writeSshdConfig(configPath, port, serverDirectory, tools);
    const child = spawn(
      tools.paths.sshd,
      ["-f", configPath, "-E", logPath, "-D"],
      {
        env: {},
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    liveSshdRegistry.add(child);
    child.unref();
    sshd = child;
    try {
      await waitForListener(port, logPath, child);
      lastError = null;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      child.kill("SIGKILL");
      const exited = await waitForExit(child, disposeKillMilliseconds);
      if (exited) {
        liveSshdRegistry.delete(child);
      }
      sshd = null;
    }
  }
  if (sshd === null || lastError !== null) {
    removeServerDirectory(serverDirectory);
    throw new Error(
      `ssh fixture: failed to start sshd after 5 attempts; last error: ${lastError?.message ?? "unknown"}; log tail: ${logTail(logPath)}`,
    );
  }

  const username = os.userInfo().username;
  let knownHostsCounter = 0;

  const remote: SshRemote = {
    transport: "ssh",
    port,
    username,
    hostKeys,
    privateKeyPath: clientKeyPath,
    wrongHostKey,
    knownHostsLine(hostKey: FixtureHostKey): string {
      return `[127.0.0.1]:${port} ${hostKey.algorithm} ${hostKey.publicKey}`;
    },
    writeKnownHosts(keys: readonly FixtureHostKey[]): string {
      knownHostsCounter += 1;
      const path = join(serverDirectory, `known_hosts_${knownHostsCounter}`);
      const lines = keys.map(
        (key) => `[127.0.0.1]:${port} ${key.algorithm} ${key.publicKey}`,
      );
      fs.writeFileSync(path, lines.join("\n") + "\n");
      return path;
    },
    sshCommand(
      input: Readonly<{ knownHosts: string; privateKey?: string }>,
    ): string {
      const keyPath = input.privateKey ?? clientKeyPath;
      return [
        quote(tools.paths.ssh),
        "-F /dev/null",
        "-o BatchMode=yes",
        "-o IdentitiesOnly=yes",
        "-o StrictHostKeyChecking=yes",
        `-o UserKnownHostsFile=${quote(input.knownHosts)}`,
        "-o IdentityAgent=none",
        `-i ${quote(keyPath)}`,
      ].join(" ");
    },
    url(repository: string): string {
      return `ssh://${username}@127.0.0.1:${port}${join(seed.path, repository)}`;
    },
    seed,
    log(): string {
      try {
        return fs.readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
    async dispose(): Promise<void> {
      let disposeError: Error | null = null;
      let confirmedExited = true;
      if (sshd !== null && sshd.exitCode === null && sshd.signalCode === null) {
        const pid = sshd.pid;
        const child = sshd;
        child.kill("SIGTERM");
        const exitedAfterTerm = await waitForExit(
          child,
          disposeGraceMilliseconds,
        );
        if (!exitedAfterTerm) {
          child.kill("SIGKILL");
          const exitedAfterKill = await waitForExit(
            child,
            disposeKillMilliseconds,
          );
          if (!exitedAfterKill) {
            confirmedExited = false;
            disposeError = new Error(
              `ssh fixture: sshd (pid ${pid ?? "unknown"}) did not exit after SIGTERM and SIGKILL; log tail: ${logTail(logPath)}`,
            );
          }
        }
      }
      if (sshd !== null && confirmedExited) {
        liveSshdRegistry.delete(sshd);
      }
      try {
        removeServerDirectory(serverDirectory);
      } catch (error) {
        if (disposeError === null) {
          disposeError =
            error instanceof Error ? error : new Error(String(error));
        }
      }
      if (disposeError !== null) {
        throw disposeError;
      }
    },
  };
  return remote;
}
