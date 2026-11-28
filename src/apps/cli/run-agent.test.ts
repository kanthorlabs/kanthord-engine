import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { ExitCode } from "./constants.ts";
import { type CliResult, runInProcess } from "./test-support.ts";

const TOKEN_CODE = "cli.run.agent.token";
const OPTION_INVALID_CODE = "cli.run.agent.option_invalid";
const DUPLICATE_CODE = "cli.option.duplicate";
const MODEL = "openai-compatible/stub-1:off";
const HELP_OPTIONS = [
  "--model",
  "--workspace",
  "--session",
  "--prompt",
  "--system-prompt",
  "--auth",
  "--budget",
  "--output",
];

function runAgent(t: TestContext, args: string[]): Promise<CliResult> {
  return runInProcess(["run", "agent", ...args], {
    ...hostEnvironment(),
    XDG_CONFIG_HOME: temporary(t),
  });
}

function firstLine(result: CliResult): string {
  return result.stderr.split("\n")[0]!;
}

test("run agent refuses --token before the absent operand and options", async (t) => {
  const result = await runAgent(t, ["--token", "value"]);
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(firstLine(result).startsWith(`${TOKEN_CODE}:`));
});

test("run agent refuses an absent operand with the option row <agent-name>", async (t) => {
  const result = await runAgent(t, ["--model", MODEL]);
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(firstLine(result).startsWith(`${OPTION_INVALID_CODE}:`));
  assert.match(result.stderr, /^option: <agent-name>$/m);
});

test("run agent refuses a repeated single-value option", async (t) => {
  const result = await runAgent(t, [
    "swe@1",
    "--model",
    MODEL,
    "--model",
    MODEL,
  ]);
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(firstLine(result).startsWith(`${DUPLICATE_CODE}:`));
  assert.match(result.stderr, /^option: --model$/m);
});

test("run agent help lists each option and no --token", async (t) => {
  const result = await runAgent(t, ["--help"]);
  assert.equal(result.code, ExitCode.Success);
  for (const option of HELP_OPTIONS) assert.ok(result.stdout.includes(option));
  assert.ok(!result.stdout.includes("--token"));
});
