import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";
import { checkSessionPath } from "./run-agent-session.ts";

const SESSION_EXISTS = "cli.run.agent.session_exists";
const ROOT_UID = 0;
const SESSION_DIR_INVALID = "cli.run.agent.session_directory_invalid";
const SESSION_PLACE = "cli.run.agent.session_place";
const SESSION_DIR_MODE = "cli.run.agent.session_directory_mode";
const SESSION_DIR_OWNER = "cli.run.agent.session_directory_owner";
const ROOT_OWNED_DIRECTORY = "/usr";
const FIELD_PATH = "path";

let base: string;
const PI_DIR = "/nonexistent-pi-dir";

before(() => {
  base = mkdtempSync(join(tmpdir(), "run-agent-session-test-"));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function workspace(): string {
  const dir = join(base, `w-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

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

describe("checkSessionPath", () => {
  it("passes for a valid new path", () => {
    const w = workspace();
    const session = join(base, "session.jsonl");
    assert.doesNotThrow(() => checkSessionPath(session, w, PI_DIR));
  });

  it("refuses an existing file", () => {
    const w = workspace();
    const session = join(base, `s-${Date.now()}.jsonl`);
    writeFileSync(session, "");
    const error = assertDiagnostic(
      () => checkSessionPath(session, w, PI_DIR),
      SESSION_EXISTS,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_PATH));
  });

  it("refuses an existing directory", () => {
    const w = workspace();
    const session = join(base, `d-${Date.now()}`);
    mkdirSync(session, { mode: 0o700 });
    assertDiagnostic(
      () => checkSessionPath(session, w, PI_DIR),
      SESSION_EXISTS,
    );
  });

  it("refuses a symbolic link to an absent path", () => {
    const w = workspace();
    const session = join(base, `link-${Date.now()}.jsonl`);
    symlinkSync("/nonexistent-target-12345", session);
    assertDiagnostic(
      () => checkSessionPath(session, w, PI_DIR),
      SESSION_EXISTS,
    );
  });

  it("refuses an absent parent directory", () => {
    const w = workspace();
    const session = join(base, "absent-parent", "session.jsonl");
    assertDiagnostic(
      () => checkSessionPath(session, w, PI_DIR),
      SESSION_DIR_INVALID,
    );
  });

  it("refuses a path inside the workspace", () => {
    const w = workspace();
    const session = join(w, "session.jsonl");
    assertDiagnostic(() => checkSessionPath(session, w, PI_DIR), SESSION_PLACE);
  });

  it("refuses a path inside the pi directory", () => {
    const piDir = join(base, `pi-${Date.now()}`);
    mkdirSync(piDir, { mode: 0o700 });
    const w = workspace();
    const session = join(piDir, "session.jsonl");
    assertDiagnostic(() => checkSessionPath(session, w, piDir), SESSION_PLACE);
  });

  it("refuses a path inside the workspace through a symbolic link", () => {
    const w = workspace();
    const alias = join(base, `alias-${Date.now()}-${Math.random()}`);
    symlinkSync(w, alias);
    const session = join(alias, "session.jsonl");
    assertDiagnostic(() => checkSessionPath(session, w, PI_DIR), SESSION_PLACE);
  });

  it("refuses a parent of another user", () => {
    if (userInfo().uid === ROOT_UID) return;
    const w = workspace();
    const session = join(ROOT_OWNED_DIRECTORY, `s-${Date.now()}.jsonl`);
    assertDiagnostic(
      () => checkSessionPath(session, w, PI_DIR),
      SESSION_DIR_OWNER,
    );
  });

  it("passes when session is a sibling of the workspace", () => {
    const w = workspace();
    const session = join(base, `session-sibling-${Date.now()}.jsonl`);
    assert.doesNotThrow(() => checkSessionPath(session, w, PI_DIR));
  });

  it("refuses a parent with group write bit", () => {
    const dirWithGroupWrite = join(base, `gw-${Date.now()}`);
    const uid = userInfo().uid;
    if (uid === ROOT_UID) return;
    mkdirSync(dirWithGroupWrite, { mode: 0o700 });
    chmodSync(dirWithGroupWrite, 0o720);
    const w = workspace();
    const session = join(dirWithGroupWrite, "session.jsonl");
    assertDiagnostic(
      () => checkSessionPath(session, w, PI_DIR),
      SESSION_DIR_MODE,
    );
    chmodSync(dirWithGroupWrite, 0o700);
  });

  it("refuses a parent with other write bit", () => {
    const dirWithOtherWrite = join(base, `ow-${Date.now()}`);
    const uid = userInfo().uid;
    if (uid === ROOT_UID) return;
    mkdirSync(dirWithOtherWrite, { mode: 0o700 });
    chmodSync(dirWithOtherWrite, 0o702);
    const w = workspace();
    const session = join(dirWithOtherWrite, "session.jsonl");
    assertDiagnostic(
      () => checkSessionPath(session, w, PI_DIR),
      SESSION_DIR_MODE,
    );
    chmodSync(dirWithOtherWrite, 0o700);
  });
});
