import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswer } from "./answer.ts";
import { CouncilErrorCode, triageSchema } from "./contract.ts";

const TRIAGE = { complexity: "M", reasons: ["Two flows change."] };

test("parseAnswer reads a bare JSON answer", () => {
  assert.deepEqual(
    parseAnswer(JSON.stringify(TRIAGE), triageSchema, "triage"),
    TRIAGE,
  );
});

test("parseAnswer takes the last json fence when the model adds prose", () => {
  const text = [
    "Here is a draft:",
    "```json",
    '{"complexity":"S","reasons":["draft"]}',
    "```",
    "Final:",
    "```json",
    JSON.stringify(TRIAGE),
    "```",
  ].join("\n");
  assert.deepEqual(parseAnswer(text, triageSchema, "triage"), TRIAGE);
});

test("parseAnswer refuses text with no JSON value", () => {
  assert.throws(
    () => parseAnswer("I think it is medium.", triageSchema, "triage"),
    {
      code: CouncilErrorCode.AnswerInvalid,
    },
  );
});

test("parseAnswer refuses JSON that misses the schema of its step", () => {
  assert.throws(
    () =>
      parseAnswer('{"complexity":"XL","reasons":[]}', triageSchema, "triage"),
    { code: CouncilErrorCode.AnswerInvalid, message: /^triage: / },
  );
});
