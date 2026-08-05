import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { GitError, type GitPaths, type HostKey } from "./index.ts";
import { spawnSupervised } from "./launcher.ts";
import { stripUserinfo } from "./redact.ts";
import { TERMINATION_GRACE_MS } from "./run.ts";
import { remoteUrlVerdict } from "./url.ts";

export const ACCEPTED_HOST_KEY_ALGORITHMS = [
  "ecdsa-sha2-nistp256",
  "ssh-ed25519",
  "ssh-rsa",
] as const;

export const KEYSCAN_TIMEOUT_MS = 15_000;
export const DEFAULT_SSH_PORT = 22;

export type ScanTarget = Readonly<{ host: string; port: number }>;

export type ScanOutcome =
  | Readonly<{ scanned: true; hostKeys: readonly HostKey[] }>
  | Readonly<{
      scanned: false;
      failure: "host-key-unavailable" | "timed-out";
      detail: string;
    }>;

export function scanTargetFor(remoteUrl: string): ScanTarget {
  const verdict = remoteUrlVerdict(remoteUrl);
  if (!verdict.allowed) {
    throw new GitError("url-refused", verdict.reason, "");
  }
  if (verdict.transport !== "ssh") {
    throw new GitError("unknown", "only an ssh url has a host key", "");
  }
  const host = verdict.host.replace(/^\[/, "").replace(/\]$/, "");
  let port = DEFAULT_SSH_PORT;
  try {
    const url = new URL(remoteUrl);
    if (url.port !== "") {
      port = Number(url.port);
    }
  } catch {
    // the scp-like spelling carries no explicit port
  }
  return { host, port };
}

export function fingerprintOf(publicKeyBase64: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export function parseKeyscanOutput(text: string): readonly HostKey[] {
  const accepted = new Set<string>(ACCEPTED_HOST_KEY_ALGORITHMS);
  const entries: Readonly<{ algorithm: string; publicKey: string }>[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(/\s+/).map((field) => field.trim());
    if (fields.length < 3) {
      continue;
    }
    const algorithm = fields[1] ?? "";
    const publicKey = fields[2] ?? "";
    if (!accepted.has(algorithm)) {
      continue;
    }
    const dedupeKey = `${algorithm}\u0000${publicKey}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    entries.push({ algorithm, publicKey });
  }
  entries.sort((left, right) => {
    const byAlgorithm = Buffer.compare(
      Buffer.from(left.algorithm),
      Buffer.from(right.algorithm),
    );
    if (byAlgorithm !== 0) {
      return byAlgorithm;
    }
    return Buffer.compare(
      Buffer.from(left.publicKey),
      Buffer.from(right.publicKey),
    );
  });
  return entries.map((entry) => ({
    algorithm: entry.algorithm,
    fingerprint: fingerprintOf(entry.publicKey),
    publicKey: entry.publicKey,
  }));
}

export function knownHostsLine(target: ScanTarget, hostKey: HostKey): string {
  return `[${target.host}]:${target.port} ${hostKey.algorithm} ${hostKey.publicKey}`;
}

export type ScanOptions = Readonly<{ timeoutMs?: number }>;

export type ConfirmOutcome =
  | Readonly<{ confirmed: true; hostKey: HostKey }>
  | Readonly<{
      confirmed: false;
      reason: "fingerprint-mismatch" | "scan-failed";
      presented: readonly string[];
      detail: string;
    }>;

export async function confirmHostKey(
  paths: GitPaths,
  remoteUrl: string,
  hostFingerprint: string,
): Promise<ConfirmOutcome> {
  const outcome = await scanHostKeys(paths, remoteUrl);
  if (!outcome.scanned) {
    return {
      confirmed: false,
      reason: "scan-failed",
      presented: [],
      detail: outcome.detail,
    };
  }
  const match = outcome.hostKeys.find(
    (entry) => entry.fingerprint === hostFingerprint,
  );
  if (match !== undefined) {
    return { confirmed: true, hostKey: match };
  }
  return {
    confirmed: false,
    reason: "fingerprint-mismatch",
    presented: outcome.hostKeys.map((entry) => entry.fingerprint),
    detail: "",
  };
}

export function parseKnownHosts(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export async function trustHostKey(
  paths: GitPaths,
  input: Readonly<{ remoteUrl: string; hostKey: HostKey }>,
): Promise<void> {
  const line = knownHostsLine(scanTargetFor(input.remoteUrl), input.hostKey);
  mkdirSync(dirname(paths.knownHosts), { recursive: true, mode: 0o700 });
  let text: string;
  try {
    text = readFileSync(paths.knownHosts, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    text = "";
  }
  if (parseKnownHosts(text).includes(line)) {
    return;
  }
  appendFileSync(paths.knownHosts, line + "\n", { mode: 0o600 });
  chmodSync(paths.knownHosts, 0o600);
}

export async function scanHostKeys(
  paths: GitPaths,
  remoteUrl: string,
  options?: ScanOptions,
): Promise<ScanOutcome> {
  const target = scanTargetFor(remoteUrl);
  const timeoutMs = options?.timeoutMs ?? KEYSCAN_TIMEOUT_MS;
  const pidFile = join(paths.runDirectory, `keyscan-${randomUUID()}.pid`);

  const child = spawnSupervised({
    command: paths.sshKeyscan,
    args: ["-T", "10", "-p", String(target.port), "--", target.host],
    env: { PATH: "", LC_ALL: "C", HOME: paths.home },
    cwd: paths.runDirectory,
    pidFile,
  });

  let stdoutChunks: Buffer[] = [];
  let stderrChunks: Buffer[] = [];
  let timedOut = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let signalError: unknown;

  try {
    if (child.pid === undefined) {
      try {
        await child.exited;
      } catch {
        // the scanner never started; report the host as unavailable
      }
      return { scanned: false, failure: "host-key-unavailable", detail: "" };
    }

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        child.signalGroup(signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") {
          signalError ??= error;
        }
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        signalGroup("SIGKILL");
      }, TERMINATION_GRACE_MS);
      graceTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    try {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      await child.exited;
      if (signalError !== undefined) {
        throw signalError;
      }
      if (timedOut) {
        return {
          scanned: false,
          failure: "timed-out",
          detail: `ssh-keyscan did not answer within ${KEYSCAN_TIMEOUT_MS}ms`,
        };
      }
      const hostKeys = parseKeyscanOutput(
        Buffer.concat(stdoutChunks).toString("utf8"),
      );
      if (hostKeys.length === 0) {
        const firstStderrLine = stripUserinfo(
          Buffer.concat(stderrChunks).toString("utf8"),
        )
          .split("\n")[0]
          ?.trim();
        return {
          scanned: false,
          failure: "host-key-unavailable",
          detail: firstStderrLine ?? "",
        };
      }
      return { scanned: true, hostKeys };
    } finally {
      clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
    }
  } finally {
    rmSync(pidFile, { force: true });
  }
}
