import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  chainConfigurations,
  checkFallbackDuplicates,
} from "./configuration.ts";
import { AgentErrorCode, ChainLevel } from "./contract.ts";

const AGENT = "swe@1";
const luna = {
  agent_provider: "codex",
  model_identifier: "gpt-6-luna",
  reasoning_effort: "medium",
};
const plus = {
  agent_provider: "qwen",
  model_identifier: "qwen3.6-plus",
  reasoning_effort: "high",
};
const nemotron = {
  agent_provider: "openrouter",
  model_identifier: "nemotron:free",
  reasoning_effort: "off",
};
const enablementTail = [plus, nemotron];

function level<T extends object>(config: T, chainLevel: ChainLevel) {
  return { ...config, level: chainLevel };
}

test("a later chain entry with the provider and model of an earlier entry is dropped", () => {
  assert.deepEqual(
    chainConfigurations(luna, enablementTail, {
      ...plus,
      reasoning_effort: "low",
    }),
    [
      level({ ...plus, reasoning_effort: "low" }, ChainLevel.Binding),
      level(nemotron, ChainLevel.Enablement),
    ],
  );
});

test("a duplicate inside one tail or a tail entry equal to its head is refused", () => {
  assert.doesNotThrow(() =>
    checkFallbackDuplicates(AGENT, luna, enablementTail),
  );
  for (const tail of [
    [plus, { ...plus, reasoning_effort: "low" }],
    [{ ...luna, reasoning_effort: "low" }],
  ])
    assert.throws(
      () => checkFallbackDuplicates(AGENT, luna, tail),
      (error) =>
        error instanceof OperationError &&
        error.code === AgentErrorCode.FallbackDuplicate &&
        error.status === HttpStatus.BadRequest,
    );
});
