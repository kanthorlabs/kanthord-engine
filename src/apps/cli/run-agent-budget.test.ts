import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Diagnostic } from "../../kernel/errors.ts";
import { parseBudget } from "./run-agent-budget.ts";

const OPTION_INVALID = "cli.run.agent.option_invalid";
const FIELD_OPTION = "option";
const BUDGET_OPTION = "--budget";
const DEFAULT_WALL_MS = 7200000;
const THIRTY_S_MS = 30000;
const TEN_MIN_MS = 600000;
const TWO_H_MS = 7200000;
const HUNDRED_H_MS = 360000000;
const FIVE_USD = 5;
const QUARTER_USD = 0.25;

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

describe("parseBudget", () => {
  it("gives the default 2h wall budget when no values given", () => {
    const result = parseBudget([]);
    assert.equal(result.wallMs, DEFAULT_WALL_MS);
    assert.equal(result.usd, null);
  });

  it("parses a wall budget in seconds", () => {
    const result = parseBudget(["30s"]);
    assert.equal(result.wallMs, THIRTY_S_MS);
  });

  it("parses a wall budget in minutes", () => {
    const result = parseBudget(["10m"]);
    assert.equal(result.wallMs, TEN_MIN_MS);
  });

  it("parses a wall budget in hours", () => {
    const result = parseBudget(["2h"]);
    assert.equal(result.wallMs, TWO_H_MS);
  });

  it("parses a large wall budget", () => {
    const result = parseBudget(["100h"]);
    assert.equal(result.wallMs, HUNDRED_H_MS);
  });

  it("parses a usd value", () => {
    const result = parseBudget(["5usd"]);
    assert.equal(result.usd, FIVE_USD);
  });

  it("parses a usd value with decimals", () => {
    const result = parseBudget(["0.25usd"]);
    assert.equal(result.usd, QUARTER_USD);
  });

  it("refuses a zero usd value", () => {
    const error = assertDiagnostic(() => parseBudget(["0usd"]), OPTION_INVALID);
    const row = error.fields.find(([name]) => name === FIELD_OPTION);
    assert.equal(row?.[1], BUDGET_OPTION);
  });

  it("refuses a repeated usd budget", () => {
    assertDiagnostic(() => parseBudget(["1usd", "2usd"]), OPTION_INVALID);
  });

  it("refuses a usd value with more than 6 decimal places", () => {
    assertDiagnostic(() => parseBudget(["0.1234567usd"]), OPTION_INVALID);
  });

  it("refuses a value of no known kind", () => {
    assertDiagnostic(() => parseBudget(["5"]), OPTION_INVALID);
  });

  it("refuses a zero wall value", () => {
    assertDiagnostic(() => parseBudget(["0h"]), OPTION_INVALID);
  });

  it("refuses a repeated wall budget", () => {
    assertDiagnostic(() => parseBudget(["1h", "30m"]), OPTION_INVALID);
  });
});
