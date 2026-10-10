import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COUNCIL_AGENT,
  CouncilErrorCode,
  ROUNDS_BY_COMPLEXITY,
  type Complexity,
} from "./contract.ts";
import { runCouncil, type Ask } from "./run.ts";

const PLAN = {
  entries: [
    {
      filename: "login.md",
      kind: "initiative",
      depends_on: [],
      bindings: [],
      verifications: ["pnpm test"],
      name: "Login",
      requirement: "A user signs in.",
      criterion: "A signed-in user sees the home page.",
    },
  ],
  reasons: { "login.md": "Every role asks for it." },
};

function fakeAsk(complexity: Complexity) {
  const calls: { agentName: string; text: string }[] = [];
  const ask: Ask = async (agentName, text) => {
    calls.push({ agentName, text });
    if (agentName !== COUNCIL_AGENT)
      return JSON.stringify({
        answers: [
          {
            question: "Who signs in?",
            answer: `SECRET-${agentName}`,
            confidence: "high",
            assumptions: [],
          },
        ],
      });
    if (text.startsWith("Step: triage."))
      return JSON.stringify({ complexity, reasons: ["reach"] });
    if (text.startsWith("Step: questions."))
      return JSON.stringify({ questions: ["Who signs in?"] });
    if (text.startsWith("Step: conflict questions."))
      return JSON.stringify({ questions: ["Email or phone?"] });
    if (text.startsWith("Step: synthesis."))
      return JSON.stringify({
        agreements: [],
        conflicts: [],
        direction: "Email login.",
      });
    return JSON.stringify(PLAN);
  };
  return { ask, calls };
}

const roleCalls = (calls: { agentName: string }[]) =>
  calls
    .filter((call) => call.agentName !== COUNCIL_AGENT)
    .map((call) => call.agentName)
    .sort();

test("S selects po and user for one round", async () => {
  const { ask, calls } = fakeAsk("S");
  const record = await runCouncil("Add login", ask);
  assert.deepEqual(roleCalls(calls), ["po@1", "user@1"]);
  assert.equal(record.rounds.length, ROUNDS_BY_COMPLEXITY.S);
  assert.deepEqual(record.plan, PLAN);
});

test("M selects four roles for one round", async () => {
  const { ask, calls } = fakeAsk("M");
  const record = await runCouncil("Add login", ask);
  assert.deepEqual(roleCalls(calls), [
    "architect@1",
    "designer@1",
    "po@1",
    "user@1",
  ]);
  assert.equal(record.rounds.length, ROUNDS_BY_COMPLEXITY.M);
});

test("L selects all five roles for two rounds", async () => {
  const { ask, calls } = fakeAsk("L");
  const record = await runCouncil("Add login", ask);
  assert.deepEqual(roleCalls(calls), [
    "architect@1",
    "architect@1",
    "designer@1",
    "designer@1",
    "po@1",
    "po@1",
    "security@1",
    "security@1",
    "user@1",
    "user@1",
  ]);
  assert.equal(record.rounds.length, ROUNDS_BY_COMPLEXITY.L);
  assert.deepEqual(record.rounds[1]!.questions, ["Email or phone?"]);
});

test("no role message contains the answer of any role", async () => {
  const { ask, calls } = fakeAsk("L");
  await runCouncil("Add login", ask);
  for (const call of calls.filter((call) => call.agentName !== COUNCIL_AGENT))
    assert.ok(!call.text.includes("SECRET-"), call.agentName);
});

test("an invalid answer fails the run", async () => {
  const ask: Ask = async () => "no json here";
  await assert.rejects(runCouncil("Add login", ask), {
    code: CouncilErrorCode.AnswerInvalid,
  });
});
