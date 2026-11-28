import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../../kernel/json.ts";
import { inputDigest } from "./run-agent-digest.ts";

describe("inputDigest", () => {
  it("produces a hex string", () => {
    const result = inputDigest({
      prompt: ["fix the bug"],
      system_prompt: [],
      provider: "openai-compatible",
      model: "stub-1",
      reasoning_effort: "off",
      budget: { wall_ms: 7200000, usd: null },
    });
    assert.match(result, /^[0-9a-f]{64}$/);
  });

  it("equals digest of the same object", () => {
    const input = {
      prompt: ["fix the bug"],
      system_prompt: ["extra context"],
      provider: "anthropic",
      model: "claude-3-5-haiku",
      reasoning_effort: "high",
      budget: { wall_ms: 1800000, usd: null },
    };
    const expected = digest({
      prompt: input.prompt,
      system_prompt: input.system_prompt,
      provider: input.provider,
      model: input.model,
      reasoning_effort: input.reasoning_effort,
      budget: input.budget,
    });
    assert.equal(inputDigest(input), expected);
  });

  it("changes when prompt parts change", () => {
    const base = {
      prompt: ["fix the bug"],
      system_prompt: [] as string[],
      provider: "openai-compatible",
      model: "stub-1",
      reasoning_effort: "off",
      budget: { wall_ms: 7200000, usd: null as null | number },
    };
    const changed = { ...base, prompt: ["fix the other bug"] };
    assert.notEqual(inputDigest(base), inputDigest(changed));
  });

  it("changes when system_prompt changes", () => {
    const base = {
      prompt: ["fix"],
      system_prompt: [] as string[],
      provider: "openai-compatible",
      model: "stub-1",
      reasoning_effort: "off",
      budget: { wall_ms: 7200000, usd: null as null | number },
    };
    const withSystem = { ...base, system_prompt: ["extra"] };
    assert.notEqual(inputDigest(base), inputDigest(withSystem));
  });

  it("produces the same digest for two runs with the same input regardless of path", () => {
    const common = {
      prompt: ["task text"],
      system_prompt: ["binding context"],
      provider: "openai-compatible",
      model: "stub-1",
      reasoning_effort: "off",
      budget: { wall_ms: 600000, usd: null },
    };
    assert.equal(inputDigest(common), inputDigest(common));
  });

  it("changes when budget wall_ms changes", () => {
    const base = {
      prompt: ["fix"],
      system_prompt: [] as string[],
      provider: "openai-compatible",
      model: "stub-1",
      reasoning_effort: "off",
      budget: { wall_ms: 7200000, usd: null as null | number },
    };
    const changed = { ...base, budget: { wall_ms: 1800000, usd: null } };
    assert.notEqual(inputDigest(base), inputDigest(changed));
  });
});
