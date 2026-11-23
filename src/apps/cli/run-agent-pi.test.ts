import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  checkAuthNotInPiDirectory,
  checkPiDirectory,
  runPiToolInstall,
} from "./run-agent-pi.ts";

const PI_DIR_INVALID = "cli.run.agent.pi_directory_invalid";
const AUTH_IN_PI_DIR = "cli.run.agent.auth_in_pi_directory";
const TOOL_INSTALL_FAILED = "cli.run.agent.tool_install_failed";
const FIELD_PATH = "path";
const ROOT_UID = 0;
const ROOT_OWNED_DIRECTORY = "/usr";
const FIELD_TOOL = "tool";
const FIELD_TARGET = "target";
const FIELD_REASON = "reason";

let base: string;

before(() => {
  base = mkdtempSync(join(tmpdir(), "run-agent-pi-test-"));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function assertDiagnostic(action: () => unknown, code: string): Diagnostic {
  let result: Diagnostic | undefined;
  assert.throws(action, (e: unknown) => {
    if (!(e instanceof Diagnostic)) return false;
    assert.equal(e.code, code);
    result = e;
    return true;
  });
  return result!;
}

describe("checkPiDirectory", () => {
  it("passes when the directory does not exist", () => {
    const piDir = join(base, `pi-absent-${Date.now()}`);
    assert.doesNotThrow(() => checkPiDirectory(piDir));
  });

  it("passes for a valid existing directory", () => {
    const piDir = join(base, `pi-valid-${Date.now()}`);
    mkdirSync(piDir, { mode: 0o700 });
    assert.doesNotThrow(() => checkPiDirectory(piDir));
  });

  it("refuses a symbolic link", () => {
    const target = join(base, `pi-target-${Date.now()}`);
    mkdirSync(target, { mode: 0o700 });
    const link = join(base, `pi-link-${Date.now()}`);
    symlinkSync(target, link);
    const error = assertDiagnostic(
      () => checkPiDirectory(link),
      PI_DIR_INVALID,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_PATH));
  });

  it("refuses a directory of another user", () => {
    if (userInfo().uid === ROOT_UID) return;
    assertDiagnostic(
      () => checkPiDirectory(ROOT_OWNED_DIRECTORY),
      PI_DIR_INVALID,
    );
  });

  it("refuses a regular file", () => {
    const file = join(base, `pi-file-${Date.now()}`);
    writeFileSync(file, "");
    assertDiagnostic(() => checkPiDirectory(file), PI_DIR_INVALID);
  });
});

describe("checkAuthNotInPiDirectory", () => {
  it("passes when no auth.json exists in pi directory", () => {
    const piDir = join(base, `pi-noauth-${Date.now()}`);
    mkdirSync(piDir, { mode: 0o700 });
    assert.doesNotThrow(() => checkAuthNotInPiDirectory(piDir));
  });

  it("refuses when auth.json exists in pi directory", () => {
    const piDir = join(base, `pi-withauth-${Date.now()}`);
    mkdirSync(piDir, { mode: 0o700 });
    writeFileSync(join(piDir, "auth.json"), "{}");
    const error = assertDiagnostic(
      () => checkAuthNotInPiDirectory(piDir),
      AUTH_IN_PI_DIR,
    );
    const row = error.fields.find(([k]) => k === FIELD_PATH);
    assert.ok(row && String(row[1]).endsWith("auth.json"));
  });
});

describe("runPiToolInstall", () => {
  it("calls the install function", () => {
    let called = false;
    runPiToolInstall(() => {
      called = true;
    });
    assert.ok(called);
  });

  it("re-throws a Diagnostic as tool_install_failed", () => {
    const original = new Diagnostic(
      "worker.start.tool_missing",
      "tool missing",
      {
        fields: [
          ["tool", "pi"],
          ["target", "linux-x64"],
        ],
      },
    );
    const error = assertDiagnostic(
      () =>
        runPiToolInstall(() => {
          throw original;
        }),
      TOOL_INSTALL_FAILED,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_TOOL));
    assert.ok(error.fields.some(([k]) => k === FIELD_TARGET));
  });

  it("wraps a non-Diagnostic error as tool_install_failed", () => {
    const error = assertDiagnostic(
      () =>
        runPiToolInstall(() => {
          throw new Error("disk full");
        }),
      TOOL_INSTALL_FAILED,
    );
    const row = error.fields.find(([k]) => k === FIELD_REASON);
    const DISK_FULL = "disk full";
    assert.equal(row?.[1], DISK_FULL);
  });
});
