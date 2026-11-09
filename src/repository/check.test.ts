import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  CheckErrorCode,
  parseGitVersion,
  parseSshVersion,
  requireTool,
} from "./check.ts";

const LOADED_HOST_TIMEOUT_MS = 50_000;

function assertDiagnosticCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, code);
    return true;
  });
}

test("parseGitVersion rejects an older version", () => {
  assertDiagnosticCode(
    () => parseGitVersion("git version 2.39.3"),
    CheckErrorCode.ToolVersion,
  );
});

test("parseGitVersion rejects malformed output", () => {
  assertDiagnosticCode(
    () => parseGitVersion("not a git version string"),
    CheckErrorCode.ToolMissing,
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
