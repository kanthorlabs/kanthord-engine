import { test } from "node:test";
import { SuiteRun } from "./run.ts";

const DEFAULT_REPEAT = 3;
const MIN_REPEAT = 1;
const RERUN_ENABLED = "1";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The variable ${name} is required.`);
  return value;
}

function repeatOf(): number {
  const text = process.env.EVAL_REPEAT;
  if (!text) return DEFAULT_REPEAT;
  const repeat = Number(text);
  if (!Number.isInteger(repeat) || repeat < MIN_REPEAT)
    throw new Error("The variable EVAL_REPEAT must be a positive integer.");
  return repeat;
}

function casesOf(): string[] {
  return (process.env.EVAL_CASES ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id);
}

const suite = new SuiteRun({
  agent: required("EVAL_AGENT"),
  repeat: repeatOf(),
  cases: casesOf(),
  output: required("EVAL_OUTPUT"),
  history: required("EVAL_HISTORY"),
  rerun: process.env.EVAL_RERUN === RERUN_ENABLED,
  key: required("EVAL_ANTHROPIC_API_KEY"),
});

for (const job of suite.jobs) test(job.title, (t) => suite.play(t, job));

test("write the run file", () => {
  suite.finish();
});
