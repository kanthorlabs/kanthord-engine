import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  checkOutputPath,
  parseOutputTarget,
  resultLine,
  textLayout,
} from "./run-agent-output.ts";
import type { RunAgentResult } from "./run-agent-output.ts";
import type { OutputPathContext } from "./run-agent-output.ts";

const OUTPUT_INVALID = "cli.run.agent.output_invalid";
const ROOT_UID = 0;
const OUTPUT_PLACE = "cli.run.agent.output_place";
const DONE_TEXT = "done-1";
const ROOT_OWNED_DIRECTORY = "/usr";

let base: string;
const PI_DIR = "/nonexistent-pi-dir-output";

before(() => {
  base = mkdtempSync(join(tmpdir(), "run-agent-output-test-"));
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

function makeContext(w: string, session: string): OutputPathContext {
  return {
    workspaceRealPath: w,
    piDirectoryPath: PI_DIR,
    authRealPath: null,
    sessionAbsPath: session,
  };
}

describe("checkOutputPath", () => {
  it("passes for a valid new path", () => {
    const w = workspace();
    const output = join(base, `result-${Date.now()}.jsonl`);
    const session = join(base, "session.jsonl");
    assert.doesNotThrow(() => checkOutputPath(output, makeContext(w, session)));
  });

  it("passes for an existing 0600 file owned by this user", () => {
    const w = workspace();
    const output = join(base, `existing-${Date.now()}.jsonl`);
    writeFileSync(output, "", { mode: 0o600 });
    const session = join(base, "session.jsonl");
    assert.doesNotThrow(() => checkOutputPath(output, makeContext(w, session)));
  });

  it("refuses a symbolic link", () => {
    const w = workspace();
    const target = join(base, `tgt-${Date.now()}.jsonl`);
    writeFileSync(target, "", { mode: 0o600 });
    const link = join(base, `link-${Date.now()}.jsonl`);
    symlinkSync(target, link);
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () => checkOutputPath(link, makeContext(w, session)),
      OUTPUT_INVALID,
    );
  });

  it("refuses an existing file with mode 0640", () => {
    const uid = userInfo().uid;
    if (uid === ROOT_UID) return;
    const w = workspace();
    const output = join(base, `mode640-${Date.now()}.jsonl`);
    writeFileSync(output, "", { mode: 0o600 });
    chmodSync(output, 0o640);
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () => checkOutputPath(output, makeContext(w, session)),
      OUTPUT_INVALID,
    );
  });

  it("refuses a path inside the workspace", () => {
    const w = workspace();
    const output = join(w, `result.jsonl`);
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () => checkOutputPath(output, makeContext(w, session)),
      OUTPUT_PLACE,
    );
  });

  it("refuses a path inside the workspace through a symbolic link", () => {
    const w = workspace();
    const alias = join(base, `alias-${Date.now()}-${Math.random()}`);
    symlinkSync(w, alias);
    const output = join(alias, "result.jsonl");
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () => checkOutputPath(output, makeContext(w, session)),
      OUTPUT_PLACE,
    );
  });

  it("refuses a path inside the pi directory", () => {
    const w = workspace();
    const piDir = join(base, `pi-${Date.now()}-${Math.random()}`);
    mkdirSync(piDir, { mode: 0o700 });
    const output = join(piDir, "result.jsonl");
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () =>
        checkOutputPath(output, {
          ...makeContext(w, session),
          piDirectoryPath: piDir,
        }),
      OUTPUT_PLACE,
    );
  });

  it("refuses the --auth file", () => {
    const w = workspace();
    const auth = join(base, `auth-${Date.now()}-${Math.random()}.json`);
    writeFileSync(auth, "{}", { mode: 0o600 });
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () =>
        checkOutputPath(auth, {
          ...makeContext(w, session),
          authRealPath: realpathSync(auth),
        }),
      OUTPUT_PLACE,
    );
  });

  it("refuses the session file path", () => {
    const w = workspace();
    const session = join(base, `s-${Date.now()}-${Math.random()}.jsonl`);
    assertDiagnostic(
      () => checkOutputPath(session, makeContext(w, session)),
      OUTPUT_PLACE,
    );
  });

  it("refuses a parent of another user", () => {
    if (userInfo().uid === ROOT_UID) return;
    const w = workspace();
    const output = join(ROOT_OWNED_DIRECTORY, `r-${Date.now()}.jsonl`);
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () => checkOutputPath(output, makeContext(w, session)),
      OUTPUT_INVALID,
    );
  });

  it("refuses absent parent directory", () => {
    const w = workspace();
    const output = join(base, "absent", "result.jsonl");
    const session = join(base, "session.jsonl");
    assertDiagnostic(
      () => checkOutputPath(output, makeContext(w, session)),
      OUTPUT_INVALID,
    );
  });

  it("refuses a parent with group write bit", () => {
    const uid = userInfo().uid;
    if (uid === ROOT_UID) return;
    const dir = join(base, `gw-out-${Date.now()}`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o720);
    const output = join(dir, "result.jsonl");
    const session = join(base, "session.jsonl");
    const w = workspace();
    assertDiagnostic(
      () => checkOutputPath(output, makeContext(w, session)),
      OUTPUT_INVALID,
    );
    chmodSync(dir, 0o700);
  });
});

describe("parseOutputTarget", () => {
  it("selects stdout with no value", () => {
    assert.deepEqual(parseOutputTarget(undefined), { kind: "stdout" });
  });

  it("selects stdout for the value stdout", () => {
    assert.deepEqual(parseOutputTarget("stdout"), { kind: "stdout" });
  });

  it("selects a file for ./stdout", () => {
    assert.deepEqual(parseOutputTarget("./stdout"), {
      kind: "path",
      path: resolve("stdout"),
    });
  });
});

describe("textLayout", () => {
  const sample = {
    agent: "swe@1",
    end: "completed",
    model: "stub-1",
    reasoning_effort: "off",
    provider: "openai-compatible",
    exitCode: 0,
    classValue: "none",
    failure: null,
    budget_reached: null,
    budgetDisplay: "2h wall (default)",
    duration_ms: 400,
    model_calls: 3,
    tool_calls: 2,
    usage: { input: 30, output: 6, cache_read: 0, cache_write: 0 },
    list_price_usd: 0,
    session: "/tmp/l2/d/s.jsonl",
    workspace: "/tmp/l2/w",
    text: "done-1",
  };

  it("starts with agent and end", () => {
    const output = textLayout(sample);
    assert.ok(output.startsWith("swe@1 completed\n"));
  });

  it("includes each labeled row with 11-char padding", () => {
    const output = textLayout(sample);
    assert.ok(output.includes("  model      openai-compatible/stub-1:off\n"));
    assert.ok(output.includes("  exit       0\n"));
    assert.ok(output.includes("  class      none\n"));
    assert.ok(output.includes("  budget     2h wall (default)\n"));
    assert.ok(output.includes("  duration   0.4 s\n"));
    assert.ok(output.includes("  calls      3 model, 2 tool\n"));
    assert.ok(
      output.includes(
        "  tokens     30 input, 6 output, 0 cache read, 0 cache write\n",
      ),
    );
    assert.ok(output.includes("  list price 0.000000 usd\n"));
    assert.ok(output.includes("  session    /tmp/l2/d/s.jsonl\n"));
    assert.ok(output.includes("  workspace  /tmp/l2/w\n"));
  });

  it("ends with text after empty line", () => {
    const output = textLayout(sample);
    const parts = output.split("\n\n");
    assert.equal(parts.at(-1), DONE_TEXT);
  });

  it("omits failure row when no failure", () => {
    const output = textLayout(sample);
    assert.ok(!output.includes("failure"));
  });

  it("includes failure row when present", () => {
    const output = textLayout({
      ...sample,
      end: "failed",
      failure: "unauthorized",
    });
    assert.ok(output.includes("  failure    unauthorized\n"));
  });

  it("includes reached row for budget_end", () => {
    const output = textLayout({
      ...sample,
      end: "budget_end",
      budget_reached: "wall",
    });
    assert.ok(output.includes("  reached    wall\n"));
  });

  it("shows (no text) when text is null", () => {
    const output = textLayout({ ...sample, text: null });
    assert.ok(output.endsWith("(no text)"));
  });
});

describe("resultLine", () => {
  const result: RunAgentResult = {
    agent: "swe@1",
    engine_version: "0.0.0",
    provider: "openai-compatible",
    model: "stub-1",
    reasoning_effort: "off",
    budget: { wall_ms: 7200000, usd: null },
    budget_reached: null,
    input_digest: "a",
    system_prompt_digest: "b",
    workspace: "/w",
    session: "/d/s.jsonl",
    end: "completed",
    class: null,
    failure: null,
    duration_ms: 400,
    model_calls: 3,
    tool_calls: 2,
    usage: { input: 30, output: 6, cache_read: 0, cache_write: 0 },
    list_price_usd: 0,
    text: DONE_TEXT,
  };

  it("writes one compact JSON line with exactly the result fields", () => {
    const extra = { ...result, extra: "x", usage: { ...result.usage, y: 1 } };
    const line = resultLine(extra);
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(JSON.parse(line), result);
  });
});
