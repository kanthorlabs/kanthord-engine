import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  forgeConventions,
  type GitCredential,
  type GitFailure,
  type GitPaths,
} from "./index.ts";

export const HELPER_FILE_NAME = "credential-helper.sh";

export const HELPER_SCRIPT = `#!/bin/sh
printf '%s\\n' "$1" >> "$KANTHORD_HELPER_LOG"
if [ "$1" = get ]; then
  printf 'username=%s\\npassword=%s\\n' "$KANTHORD_GIT_USERNAME" "$KANTHORD_GIT_PASSWORD"
fi
exit 0
`;

const SSH_WRAPPER_FILE_NAME = "ssh-wrapper.sh";

const SSH_WRAPPER_SCRIPT = `#!/bin/sh
exec "$KANTHORD_SSH" \\
  -F /dev/null \\
  -o BatchMode=yes \\
  -o IdentitiesOnly=yes \\
  -o StrictHostKeyChecking=yes \\
  -o UserKnownHostsFile="$KANTHORD_KNOWN_HOSTS" \\
  -o IdentityAgent=none \\
  -i "$KANTHORD_SSH_KEY" \\
  "$@"
`;

export type CredentialSession = Readonly<{
  extraEnv: Readonly<Record<string, string>>;
  dispose(): void;
  eraseObserved(): boolean;
}>;

function secureKeyDirectory(paths: GitPaths): void {
  mkdirSync(paths.keyDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.keyDirectory, 0o700);
}

function eraseInLog(logPath: string): boolean {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .some((line) => line === "erase");
}

export function installHelper(paths: GitPaths): string {
  secureKeyDirectory(paths);
  const helperPath = join(paths.keyDirectory, HELPER_FILE_NAME);
  writeFileSync(helperPath, HELPER_SCRIPT, { mode: 0o700 });
  return helperPath;
}

export function openCredentialSession(
  paths: GitPaths,
  credential: GitCredential,
): CredentialSession {
  if (credential.transport === "http-basic") {
    return openHttpSession(paths, credential);
  }
  return openSshSession(paths, credential);
}

function openHttpSession(
  paths: GitPaths,
  credential: Extract<GitCredential, { transport: "http-basic" }>,
): CredentialSession {
  installHelper(paths);
  const logPath = join(paths.keyDirectory, `helper-${randomUUID()}.log`);
  const logFd = openSync(logPath, "wx", 0o600);
  closeSync(logFd);
  const username =
    forgeConventions[credential.forge]?.username ?? credential.username;
  const extraEnv = {
    KANTHORD_HELPER_LOG: logPath,
    KANTHORD_GIT_USERNAME: username,
    KANTHORD_GIT_PASSWORD: credential.token,
  };
  return {
    extraEnv,
    dispose(): void {
      rmSync(logPath, { force: true });
    },
    eraseObserved(): boolean {
      return eraseInLog(logPath);
    },
  };
}

function openSshSession(
  paths: GitPaths,
  credential: Extract<GitCredential, { transport: "ssh" }>,
): CredentialSession {
  secureKeyDirectory(paths);
  const keyPath = join(paths.keyDirectory, `key-${randomUUID()}`);
  const keyFd = openSync(keyPath, "wx", 0o600);
  try {
    const content = credential.privateKey.endsWith("\n")
      ? credential.privateKey
      : `${credential.privateKey}\n`;
    writeSync(keyFd, content);
  } finally {
    closeSync(keyFd);
  }
  try {
    const wrapperPath = installSshWrapper(paths);
    return {
      extraEnv: {
        GIT_SSH_COMMAND: shellQuote(wrapperPath),
        KANTHORD_SSH: paths.ssh,
        KANTHORD_KNOWN_HOSTS: paths.knownHosts,
        KANTHORD_SSH_KEY: keyPath,
      },
      dispose(): void {
        rmSync(keyPath, { force: true });
      },
      eraseObserved(): boolean {
        return false;
      },
    };
  } catch (error) {
    rmSync(keyPath, { force: true });
    throw error;
  }
}

export function credentialArgs(
  paths: GitPaths,
  credential: GitCredential,
): readonly string[] {
  if (credential.transport === "ssh") {
    return [];
  }
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${join(paths.keyDirectory, HELPER_FILE_NAME)}`,
  ];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function installSshWrapper(paths: GitPaths): string {
  secureKeyDirectory(paths);
  const wrapperPath = join(paths.keyDirectory, SSH_WRAPPER_FILE_NAME);
  writeFileSync(wrapperPath, SSH_WRAPPER_SCRIPT, { mode: 0o700 });
  return wrapperPath;
}

export function classifyFailure(
  input: Readonly<{ code: number; stderr: string; eraseObserved: boolean }>,
): GitFailure {
  if (input.eraseObserved) {
    return "auth-failed";
  }
  if (
    input.stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED") ||
    input.stderr.includes("Host key verification failed")
  ) {
    return "host-key-mismatch";
  }
  if (
    input.stderr.includes("Permission denied (publickey") ||
    input.stderr.includes("Authentication failed")
  ) {
    return "auth-failed";
  }
  if (
    input.stderr.includes("pre-receive hook declined") ||
    input.stderr.includes("protected branch") ||
    input.stderr.includes("deny updating") ||
    input.stderr.includes("You are not allowed to push code")
  ) {
    return "permission-denied";
  }
  if (
    input.stderr.includes("Could not resolve host") ||
    input.stderr.includes("Connection refused") ||
    input.stderr.includes("Connection timed out") ||
    input.stderr.includes("SSL certificate problem") ||
    input.stderr.includes("unable to access") ||
    input.stderr.includes("Connection closed by remote host")
  ) {
    return "transport-failed";
  }
  return "unknown";
}
