import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";

import type { GitPaths } from "./index.ts";
import {
  HELPER_FILE_NAME,
  HELPER_SCRIPT,
  classifyFailure,
  credentialArgs,
  installHelper,
  installSshWrapper,
  openCredentialSession,
  shellQuote,
} from "./credential.ts";
import type { CredentialSession } from "./credential.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-credential-"));
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

function modeString(filePath: string): string {
  return (statSync(filePath).mode & 0o777).toString(8);
}

describe("src/services/git/credential.test", () => {
  it("credentialArgs for an http-basic credential are the four pinned elements with the empty reset first", () => {
    const paths = makePaths();
    const args = credentialArgs(paths, {
      transport: "http-basic",
      forge: "github",
      username: "bot",
      token: "secret",
    });
    assert.deepEqual(args, [
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${join(paths.keyDirectory, HELPER_FILE_NAME)}`,
    ]);
    assert.equal(args[1], "credential.helper=");
  });

  it("credentialArgs for an ssh credential is empty", () => {
    const paths = makePaths();
    assert.deepEqual(
      credentialArgs(paths, { transport: "ssh", privateKey: "key" }),
      [],
    );
  });

  it("the forge table drives the username sent", () => {
    const paths = makePaths();
    const cases = [
      { forge: "github", expected: "bot" },
      { forge: "gitlab", expected: "oauth2" },
      { forge: "bitbucket", expected: "x-token-auth" },
      { forge: "codeberg", expected: "bot" },
    ] as const;
    for (const entry of cases) {
      const session: CredentialSession = openCredentialSession(paths, {
        transport: "http-basic",
        forge: entry.forge,
        username: "bot",
        token: "t",
      });
      assert.equal(
        session.extraEnv.KANTHORD_GIT_USERNAME,
        entry.expected,
        entry.forge,
      );
      session.dispose();
    }
  });

  it("classifyFailure decides the verdict by the documented table", () => {
    const rows = [
      { eraseObserved: true, stderr: "", verdict: "auth-failed" },
      {
        eraseObserved: true,
        stderr: "Connection refused",
        verdict: "auth-failed",
      },
      {
        eraseObserved: false,
        stderr: "REMOTE HOST IDENTIFICATION HAS CHANGED",
        verdict: "host-key-mismatch",
      },
      {
        eraseObserved: false,
        stderr: "Host key verification failed.",
        verdict: "host-key-mismatch",
      },
      {
        eraseObserved: false,
        stderr: "git@h: Permission denied (publickey).",
        verdict: "auth-failed",
      },
      {
        eraseObserved: false,
        stderr: "remote: error: pre-receive hook declined",
        verdict: "permission-denied",
      },
      {
        eraseObserved: false,
        stderr: "remote: error: You are not allowed to push code",
        verdict: "permission-denied",
      },
      {
        eraseObserved: false,
        stderr: "ssh: Could not resolve host: forge.test",
        verdict: "transport-failed",
      },
      {
        eraseObserved: false,
        stderr: "fatal: unable to access 'https://f/r.git/'",
        verdict: "transport-failed",
      },
      {
        eraseObserved: false,
        stderr: "fatal: the remote end hung up unexpectedly",
        verdict: "unknown",
      },
    ] as const;
    for (const row of rows) {
      assert.equal(
        classifyFailure({
          code: 1,
          stderr: row.stderr,
          eraseObserved: row.eraseObserved,
        }),
        row.verdict,
        JSON.stringify(row),
      );
    }
  });

  it("HELPER_SCRIPT answers credentials and never traces the secret line", () => {
    for (const line of HELPER_SCRIPT.split("\n")) {
      const secretOnTheAnswerLine =
        line.includes("KANTHORD_GIT_PASSWORD") &&
        line.includes(`printf '%s\\n' "$1"`);
      assert.ok(!secretOnTheAnswerLine, line);
    }
    assert.ok(!HELPER_SCRIPT.includes("set -x"), HELPER_SCRIPT);
  });

  it("installHelper writes the helper 0700 under a 0700 directory and is idempotent", () => {
    const paths = makePaths();
    const first = installHelper(paths);
    assert.equal(first, join(paths.keyDirectory, HELPER_FILE_NAME));
    assert.equal(modeString(paths.keyDirectory), "700");
    assert.equal(modeString(first), "700");
    assert.equal(readFileSync(first, "utf8"), HELPER_SCRIPT);
    writeFileSync(first, "stale script");
    const second = installHelper(paths);
    assert.equal(second, first);
    assert.equal(readFileSync(first, "utf8"), HELPER_SCRIPT);
  });

  it("shellQuote wraps in single quotes and escapes an embedded quote", () => {
    assert.equal(shellQuote("/plain/path"), "'/plain/path'");
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
  });

  it("installSshWrapper writes the pinned ssh command", () => {
    const paths = makePaths();
    const wrapperPath = installSshWrapper(paths);
    assert.equal(wrapperPath, join(paths.keyDirectory, "ssh-wrapper.sh"));
    assert.equal(modeString(wrapperPath), "700");
    const script = readFileSync(wrapperPath, "utf8");
    for (const pinned of [
      "-F /dev/null",
      "-o BatchMode=yes",
      "-o IdentitiesOnly=yes",
      "-o StrictHostKeyChecking=yes",
      "-o IdentityAgent=none",
    ]) {
      assert.ok(script.includes(pinned), pinned);
    }
    assert.ok(!script.includes("accept-new"), script);
    assert.ok(!script.includes("UserKnownHostsFile=/dev/null"), script);
    assert.ok(
      script.includes('UserKnownHostsFile="$KANTHORD_KNOWN_HOSTS"'),
      script,
    );
    assert.ok(script.includes('-i "$KANTHORD_SSH_KEY"'), script);
  });

  it("an ssh session routes the paths through the wrapper environment, not a shell string", () => {
    const paths = makePaths();
    const session: CredentialSession = openCredentialSession(paths, {
      transport: "ssh",
      privateKey: "key\n",
    });
    assert.equal(
      session.extraEnv.GIT_SSH_COMMAND,
      shellQuote(join(paths.keyDirectory, "ssh-wrapper.sh")),
    );
    assert.equal(session.extraEnv.KANTHORD_SSH, paths.ssh);
    assert.equal(session.extraEnv.KANTHORD_KNOWN_HOSTS, paths.knownHosts);
    const keyPath = session.extraEnv.KANTHORD_SSH_KEY;
    assert.ok(keyPath !== undefined, "the ssh session must provide the key");
    assert.ok(keyPath.startsWith(join(paths.keyDirectory, "key-")));
    assert.equal(session.eraseObserved(), false);
    session.dispose();
  });

  it("an ssh session writes the key 0600 in a 0700 directory and removes it on dispose", () => {
    const paths = makePaths();
    const session: CredentialSession = openCredentialSession(paths, {
      transport: "ssh",
      privateKey: "key\n",
    });
    const keyPath = session.extraEnv.KANTHORD_SSH_KEY;
    assert.ok(keyPath !== undefined, "the ssh session must provide the key");
    assert.equal(modeString(keyPath), "600");
    assert.equal(modeString(paths.keyDirectory), "700");
    assert.equal(existsSync(keyPath), true);
    session.dispose();
    assert.equal(existsSync(keyPath), false);
  });

  it("the key file content ends with exactly one newline", () => {
    const paths = makePaths();
    const withNewline: CredentialSession = openCredentialSession(paths, {
      transport: "ssh",
      privateKey: "key\n",
    });
    const withNewlineKey = withNewline.extraEnv.KANTHORD_SSH_KEY;
    assert.ok(
      withNewlineKey !== undefined,
      "the ssh session must provide the key",
    );
    assert.equal(readFileSync(withNewlineKey, "utf8"), "key\n");
    withNewline.dispose();
    const without: CredentialSession = openCredentialSession(paths, {
      transport: "ssh",
      privateKey: "key",
    });
    const withoutKey = without.extraEnv.KANTHORD_SSH_KEY;
    assert.ok(withoutKey !== undefined, "the ssh session must provide the key");
    assert.equal(readFileSync(withoutKey, "utf8"), "key\n");
    without.dispose();
  });

  it("an exclusive create refuses a pre-existing key path", () => {
    const paths = makePaths();
    const probe = join(paths.keyDirectory, "excl-probe");
    const fd = openSync(probe, "wx", 0o600);
    try {
      assert.throws(() => openSync(probe, "wx", 0o600), { code: "EEXIST" });
    } finally {
      closeSync(fd);
    }
  });

  it("a setup failure after key creation still removes the key file", () => {
    const paths = makePaths();
    mkdirSync(join(paths.keyDirectory, "ssh-wrapper.sh"));
    assert.throws(() =>
      openCredentialSession(paths, { transport: "ssh", privateKey: "key\n" }),
    );
    const entries = readdirSync(paths.keyDirectory);
    assert.equal(
      entries.some((name) => name.startsWith("key-")),
      false,
      entries.join(","),
    );
  });
});
