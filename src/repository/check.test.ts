import assert from "node:assert/strict";
import test from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import {
  CheckErrorCode,
  checkRepositoryTools,
  parseGitVersion,
  parseSshVersion,
} from "./check.ts";

const GIT_MIN_VERSION = [2, 40];
const GIT_NEWER_VERSION = [2, 41];
const SSH_MIN_VERSION = [9, 0];
const SSH_NEWER_VERSION = [9, 1];

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
