import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  checkRequiredOption,
  checkTokenRefused,
  checkWorkspaceDir,
  parseModelForm,
} from "./run-agent-options.ts";

const TOKEN_CODE = "cli.run.agent.token";
const OPTION_INVALID = "cli.run.agent.option_invalid";
const FIELD_OPTION = "option";
const MODEL_OPTION = "--model";
const WORKSPACE_OPTION = "--workspace";
const PROMPT_OPTION = "--prompt";
const ANTHROPIC_PROVIDER = "anthropic";
const OPENAI_PROVIDER = "openai";
const OPENAI_COMPAT_PROVIDER = "openai-compatible";
const OFF_LEVEL = "off";
const MEDIUM_LEVEL = "medium";
const CLAUDE_MODEL = "claude-3-5-sonnet";
const STUB_MODEL = "stub-1";

let base: string;

before(() => {
  base = mkdtempSync(join(tmpdir(), "run-agent-options-test-"));
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

describe("checkTokenRefused", () => {
  it("passes when token is undefined", () => {
    assert.doesNotThrow(() => checkTokenRefused(undefined));
  });

  it("refuses any token value", () => {
    assertDiagnostic(() => checkTokenRefused("some-token-value"), TOKEN_CODE);
  });

  it("refuses an empty token string", () => {
    assertDiagnostic(() => checkTokenRefused(""), TOKEN_CODE);
  });
});

describe("parseModelForm", () => {
  it("parses a valid model form", () => {
    const result = parseModelForm(
      `${ANTHROPIC_PROVIDER}/${CLAUDE_MODEL}:${MEDIUM_LEVEL}`,
    );
    assert.equal(result.provider, ANTHROPIC_PROVIDER);
    assert.equal(result.model, CLAUDE_MODEL);
    assert.equal(result.level, MEDIUM_LEVEL);
  });

  it("parses openai-compatible provider", () => {
    const result = parseModelForm(
      `${OPENAI_COMPAT_PROVIDER}/${STUB_MODEL}:${OFF_LEVEL}`,
    );
    assert.equal(result.provider, OPENAI_COMPAT_PROVIDER);
    assert.equal(result.model, STUB_MODEL);
    assert.equal(result.level, OFF_LEVEL);
  });

  it("parses a model id containing a colon (uses last colon as separator)", () => {
    const HIGH_LEVEL = "high";
    const result = parseModelForm(`openai/model:v2:${HIGH_LEVEL}`);
    const MODEL_WITH_COLON = "model:v2";
    assert.equal(result.provider, OPENAI_PROVIDER);
    assert.equal(result.model, MODEL_WITH_COLON);
    assert.equal(result.level, HIGH_LEVEL);
  });

  it("parses a model id containing a slash", () => {
    const result = parseModelForm(`openai/provider/model-id:${OFF_LEVEL}`);
    assert.equal(result.provider, OPENAI_PROVIDER);
    const MODEL_WITH_SLASH = "provider/model-id";
    assert.equal(result.model, MODEL_WITH_SLASH);
    assert.equal(result.level, OFF_LEVEL);
  });

  it("refuses a value with no /", () => {
    const error = assertDiagnostic(
      () => parseModelForm("anthropic:off"),
      OPTION_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION),
    );
  });

  it("refuses a value with no : after the /", () => {
    const error = assertDiagnostic(
      () => parseModelForm("anthropic/claude-3-5-sonnet"),
      OPTION_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION),
    );
  });

  it("refuses a value with an empty model part", () => {
    assertDiagnostic(() => parseModelForm("anthropic/:off"), OPTION_INVALID);
  });

  it("refuses anthropic-subscription as provider", () => {
    const error = assertDiagnostic(
      () => parseModelForm("anthropic-subscription/claude:off"),
      OPTION_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION),
    );
  });

  it("refuses an unknown provider", () => {
    assertDiagnostic(
      () => parseModelForm("totally-unknown-provider/model:off"),
      OPTION_INVALID,
    );
  });

  it("refuses an unknown level", () => {
    assertDiagnostic(
      () => parseModelForm("anthropic/claude:ultra"),
      OPTION_INVALID,
    );
  });

  it("refuses an empty level", () => {
    assertDiagnostic(() => parseModelForm("anthropic/claude:"), OPTION_INVALID);
  });

  it("accepts all seven valid levels", () => {
    for (const level of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      assert.doesNotThrow(() => parseModelForm(`anthropic/claude:${level}`));
    }
  });
});

describe("checkWorkspaceDir", () => {
  it("returns the current directory when no workspace is given", () => {
    const result = checkWorkspaceDir(undefined, base);
    assert.equal(result, base);
  });

  it("returns the absolute workspace path", () => {
    const dir = join(base, `workspace-${Date.now()}`);
    mkdirSync(dir, { mode: 0o700 });
    const result = checkWorkspaceDir(dir, base);
    assert.equal(result, dir);
  });

  it("resolves relative paths against currentDir", () => {
    const dirName = `rel-workspace-${Date.now()}`;
    mkdirSync(join(base, dirName), { mode: 0o700 });
    const result = checkWorkspaceDir(dirName, base);
    assert.equal(result, join(base, dirName));
  });

  it("refuses an absent path", () => {
    const error = assertDiagnostic(
      () => checkWorkspaceDir(join(base, "nonexistent-workspace"), base),
      OPTION_INVALID,
    );
    assert.ok(
      error.fields.some(
        ([k, v]) => k === FIELD_OPTION && v === WORKSPACE_OPTION,
      ),
    );
  });

  it("refuses a regular file", () => {
    const filePath = join(base, `ws-file-${Date.now()}`);
    writeFileSync(filePath, "");
    assertDiagnostic(() => checkWorkspaceDir(filePath, base), OPTION_INVALID);
  });
});

describe("checkRequiredOption", () => {
  it("passes when value is defined", () => {
    assert.doesNotThrow(() => checkRequiredOption("value", MODEL_OPTION));
    assert.doesNotThrow(() => checkRequiredOption(["item"], PROMPT_OPTION));
    const SESSION_OPTION = "--session";
    assert.doesNotThrow(() => checkRequiredOption(0, SESSION_OPTION));
  });

  it("refuses undefined", () => {
    const error = assertDiagnostic(
      () => checkRequiredOption(undefined, MODEL_OPTION),
      OPTION_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION),
    );
  });

  it("refuses an empty array", () => {
    const error = assertDiagnostic(
      () => checkRequiredOption([], PROMPT_OPTION),
      OPTION_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === PROMPT_OPTION),
    );
  });

  it("includes the option name for <agent-name> operand", () => {
    const AGENT_NAME_OPERAND = "<agent-name>";
    const error = assertDiagnostic(
      () => checkRequiredOption(undefined, AGENT_NAME_OPERAND),
      OPTION_INVALID,
    );
    assert.equal(
      error.fields.find(([k]) => k === FIELD_OPTION)?.[1],
      AGENT_NAME_OPERAND,
    );
  });
});
