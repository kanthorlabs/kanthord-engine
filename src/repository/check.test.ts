import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { background, CancellationContext } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  CheckErrorCode,
  checkRepositoryTools,
  checkServerRepositoryTools,
  parseGitVersion,
  parseSshVersion,
  probeRepositoryTools,
  requireTool,
} from "./check.ts";
import { RepositoryComponent } from "./index.ts";

const GIT_MIN_VERSION = [2, 40];
const GIT_NEWER_VERSION = [2, 41];
const SSH_MIN_VERSION = [9, 0];
const SSH_NEWER_VERSION = [9, 1];
const LOADED_HOST_TIMEOUT_MS = 50_000;

function assertDiagnosticCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, code);
    return true;
  });
}

test("parseGitVersion accepts the minimum version", () => {
  assert.deepEqual(parseGitVersion("git version 2.40.0"), GIT_MIN_VERSION);
});

test("parseGitVersion accepts a newer version", () => {
  assert.deepEqual(parseGitVersion("git version 2.41.0"), GIT_NEWER_VERSION);
});

test("parseGitVersion rejects an older version", () => {
  assertDiagnosticCode(
    () => parseGitVersion("git version 2.39.3"),
    CheckErrorCode.ToolVersion,
  );
  assert.throws(() => parseGitVersion("git version 2.39.3"), {
    message: "tool version is below the minimum version",
    fields: [
      ["tool", "git"],
      ["tool_version", "2.39"],
      ["minimum_version", "2.40"],
    ],
  });
});

test("parseGitVersion rejects malformed output", () => {
  assertDiagnosticCode(
    () => parseGitVersion("not a git version string"),
    CheckErrorCode.ToolMissing,
  );
});

test("parseSshVersion accepts the minimum version", () => {
  assert.deepEqual(
    parseSshVersion("OpenSSH_9.0p1, OpenSSL 3.0.8 5 Feb 2023"),
    SSH_MIN_VERSION,
  );
});

test("parseSshVersion accepts a newer version", () => {
  assert.deepEqual(
    parseSshVersion("OpenSSH_9.1p1, LibreSSL 3.3.6"),
    SSH_NEWER_VERSION,
  );
});

test("parseSshVersion rejects an older version", () => {
  assertDiagnosticCode(
    () => parseSshVersion("OpenSSH_8.9p1, OpenSSL 1.1.1n 15 Mar 2022"),
    CheckErrorCode.ToolVersion,
  );
});

test("parseSshVersion rejects malformed output", () => {
  assertDiagnosticCode(
    () => parseSshVersion("not an ssh version string"),
    CheckErrorCode.ToolMissing,
  );
});

test("checkRepositoryTools accepts the installed tools", () => {
  assert.doesNotThrow(() => checkRepositoryTools());
});

test("checkServerRepositoryTools accepts the installed tools", () => {
  assert.doesNotThrow(() => checkServerRepositoryTools());
});

test("requireTool accepts a present SSH agent tool", () => {
  assert.doesNotThrow(() => requireTool("ssh-agent"));
  assert.doesNotThrow(() => requireTool("ssh-add"));
  assert.doesNotThrow(() => requireTool("ssh-keyscan"));
});

test("requireTool runs the tool without the agent of the host", (t) => {
  const root = temporary(t);
  const tool = "kanthord-fake-ssh-add";
  const record = join(root, "environment");
  writeFileSync(join(root, tool), `#!/bin/sh\nenv > '${record}'\n`);
  chmodSync(join(root, tool), 0o700);
  execFileSync(join(root, tool));
  rmSync(record);
  const path = process.env.PATH;
  const socket = process.env.SSH_AUTH_SOCK;
  process.env.PATH = `${root}${delimiter}${path ?? ""}`;
  process.env.SSH_AUTH_SOCK = join(root, "host-agent");
  try {
    requireTool(tool, LOADED_HOST_TIMEOUT_MS);
  } finally {
    process.env.PATH = path;
    if (socket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = socket;
  }
  const environment = readFileSync(record, "utf8");
  assert.doesNotMatch(environment, /^SSH_AUTH_SOCK=/m);
  assert.doesNotMatch(environment, /^SSH_AGENT_PID=/m);
});

test("requireTool refuses a missing tool", () => {
  assertDiagnosticCode(
    () => requireTool("kanthord-missing-ssh-agent"),
    CheckErrorCode.ToolMissing,
  );
});

test("probeRepositoryTools accepts the installed tools", async () => {
  assert.equal(await probeRepositoryTools(background), true);
});

test("probeRepositoryTools resolves false for a cancelled context", async () => {
  const context = new CancellationContext();
  context.cancel();
  assert.equal(await probeRepositoryTools(context), false);
});

test("RepositoryComponent registers its toolchain healthcheck", async () => {
  const registry = new HealthRegistry();
  new RepositoryComponent({ health: registry });
  const result = await registry.check(background);
  assert.ok(Object.hasOwn(result, "repository"));
  assert.deepEqual(result.repository, { toolchain: HealthStatus.Healthy });
});
