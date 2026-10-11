import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  chainConfigurations,
  checkFallbackDuplicates,
  tailOf,
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

test("a chain inherits the enablement tail when the entry omits the field", () => {
  assert.deepEqual(chainConfigurations(luna, enablementTail, null), [
    level(luna, ChainLevel.Enablement),
    level(plus, ChainLevel.Enablement),
    level(nemotron, ChainLevel.Enablement),
  ]);
  assert.deepEqual(
    chainConfigurations(luna, enablementTail, { reasoning_effort: "high" }),
    [
      level({ ...luna, reasoning_effort: "high" }, ChainLevel.Binding),
      level(plus, ChainLevel.Enablement),
      level(nemotron, ChainLevel.Enablement),
    ],
  );
  assert.equal(tailOf(enablementTail, null), enablementTail);
});

test("a named binding tail replaces the enablement tail whole and an empty tail means no fallback", () => {
  assert.deepEqual(
    chainConfigurations(luna, enablementTail, {
      ...plus,
      fallback_configurations: [nemotron],
    }),
    [level(plus, ChainLevel.Binding), level(nemotron, ChainLevel.Binding)],
  );
  assert.deepEqual(
    chainConfigurations(luna, enablementTail, { fallback_configurations: [] }),
    [level(luna, ChainLevel.Enablement)],
  );
});

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
