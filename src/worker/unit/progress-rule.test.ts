import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptTemplate } from "../../agent/contract.ts";
import { STOP_DETAIL_MAX_LENGTH } from "../../scheduler/contract.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import {
  AGENT_REASON_MAX_LENGTH,
  noProgressDetail,
  NoProgressRule,
} from "./progress-rule.ts";

const LIMIT = 2;
const SHORT_COMMAND_LENGTH = 1500;
const LONG_COMMAND_LENGTH = 2048;
const EMPTY_REASON = "";

function factsWith(command: string) {
  return {
    rule: NoProgressRule.UnchangedRevision,
    count: LIMIT,
    limit: LIMIT,
    verification: {
      passed: false,
      ran: 1,
      index: 0,
      command,
      limit_ms: COMMAND_LIMIT_MS,
      exit_code: 1,
      timed_out: false,
    },
    unit_id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    template: PromptTemplate.TaskRevision,
    agent_reason: "r".repeat(AGENT_REASON_MAX_LENGTH),
  };
}

test("the detail fitting cuts agent_reason before command", () => {
  const short = "c".repeat(SHORT_COMMAND_LENGTH);
  const kept = JSON.parse(noProgressDetail(factsWith(short)));
  assert.equal(kept.verification.command, short);
  assert.ok(kept.agent_reason.length < AGENT_REASON_MAX_LENGTH);
  assert.equal(JSON.stringify(kept).length, STOP_DETAIL_MAX_LENGTH);

  const long = "c".repeat(LONG_COMMAND_LENGTH);
  const detail = noProgressDetail(factsWith(long));
  const cut = JSON.parse(detail);
  assert.equal(cut.agent_reason, EMPTY_REASON);
  assert.ok(cut.verification.command.length < LONG_COMMAND_LENGTH);
  assert.ok(long.startsWith(cut.verification.command));
  assert.ok(detail.length <= STOP_DETAIL_MAX_LENGTH);
});
