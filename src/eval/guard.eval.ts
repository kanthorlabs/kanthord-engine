import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { credentialSourceOf } from "./credential.ts";
import { GUARD_SUBJECT, runGuardSuite } from "./guard-run.ts";

const DEFAULT_REPEAT = 3;
const MIN_REPEAT = 1;
const RERUN_ENABLED = "1";
const SUITE_TIMEOUT_MS = 1800000;
const PROOF_PATH = fileURLToPath(
  new URL("../../eval/guard/proof.json", import.meta.url),
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The variable ${name} is required.`);
  return value;
}

function agentOf(): string {
  const agent = required("EVAL_AGENT");
  if (agent !== GUARD_SUBJECT)
    throw new Error(`The variable EVAL_AGENT must be ${GUARD_SUBJECT}.`);
  return agent;
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

agentOf();
const options = {
  repeat: repeatOf(),
  cases: casesOf(),
  output: required("EVAL_OUTPUT"),
  history: required("EVAL_HISTORY"),
  rerun: process.env.EVAL_RERUN === RERUN_ENABLED,
  credential: credentialSourceOf(process.env),
  proof: PROOF_PATH,
};

test("run the guard suite", { timeout: SUITE_TIMEOUT_MS }, async (t) => {
  await runGuardSuite(t, options);
});
