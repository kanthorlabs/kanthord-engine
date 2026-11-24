import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  budgetResultFields,
  checkBudgetUnpriced,
  parseBudget,
} from "./run-agent-budget.ts";

const OPTION_INVALID = "cli.run.agent.option_invalid";
const BUDGET_UNPRICED = "cli.run.agent.budget_unpriced";
const FIELD_OPTION = "option";
const BUDGET_OPTION = "--budget";
const DEFAULT_WALL_MS = 7200000;
const THIRTY_S_MS = 30000;
const TEN_MIN_MS = 600000;
const TWO_H_MS = 7200000;
const HUNDRED_H_MS = 360000000;
const FIVE_USD = 5;
const QUARTER_USD = 0.25;
const SMALLEST_USD = 0.000001;
const NO_PRICE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OUTPUT_PRICE = { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 };

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

  it("parses a usd value with 6 fraction digits", () => {
    const result = parseBudget(["0.000001usd"]);
    assert.equal(result.usd, SMALLEST_USD);
  });

  it("refuses a zero usd value with fraction digits", () => {
    assertDiagnostic(() => parseBudget(["0.000000usd"]), OPTION_INVALID);
  });

  it("refuses a usd value with an upper case suffix, no integer part, no fraction digit, a sign or an exponent", () => {
    for (const value of ["5USD", ".5usd", "5.usd", "-5usd", "+5usd", "1e3usd"])
      assertDiagnostic(() => parseBudget([value]), OPTION_INVALID);
  });

  it("parses a wall budget and a usd budget in each order", () => {
    const wallFirst = parseBudget(["30s", "5usd"]);
    assert.equal(wallFirst.wallMs, THIRTY_S_MS);
    assert.equal(wallFirst.usd, FIVE_USD);
    const usdFirst = parseBudget(["5usd", "30s"]);
    assert.equal(usdFirst.wallMs, THIRTY_S_MS);
    assert.equal(usdFirst.usd, FIVE_USD);
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

describe("budgetResultFields", () => {
  it("gives the usd budget as a number", () => {
    const raw = ["30s", "5usd"];
    const fields = budgetResultFields(parseBudget(raw), raw);
    assert.equal(fields.wall_ms, THIRTY_S_MS);
    assert.equal(fields.usd, FIVE_USD);
  });
});

describe("checkBudgetUnpriced", () => {
  it("refuses a cost budget for a model with no price", () => {
    const error = assertDiagnostic(
      () => checkBudgetUnpriced(FIVE_USD, NO_PRICE),
      BUDGET_UNPRICED,
    );
    const row = error.fields.find(([name]) => name === FIELD_OPTION);
    assert.equal(row?.[1], BUDGET_OPTION);
  });

  it("accepts a cost budget for a model with one price", () => {
    checkBudgetUnpriced(FIVE_USD, OUTPUT_PRICE);
  });

  it("accepts no cost budget for a model with no price", () => {
    checkBudgetUnpriced(null, NO_PRICE);
  });
});
