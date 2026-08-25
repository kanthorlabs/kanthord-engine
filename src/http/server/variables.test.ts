import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Context } from "hono";

import { demand, optional, VariableError } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

describe("src/http/server/variables.test", () => {
  const absentVariables = [
    { name: "headers", message: "the headers variable is absent" },
    { name: "match", message: "the match variable is absent" },
    { name: "actor", message: "the actor variable is absent" },
  ] as const;

  for (const { name, message } of absentVariables) {
    it(`a demand of an absent ${name} variable throws VariableError naming it`, () => {
      const context = new Context<AppEnv>(
        new Request("https://kanthord.invalid/v1/system/health"),
      );
      assert.throws(
        () => demand(context, name),
        (error: unknown) =>
          error instanceof VariableError && error.message === message,
      );
    });
  }

  it("a demand of a present headers variable returns the exact stored object", () => {
    const context = new Context<AppEnv>(
      new Request("https://kanthord.invalid/v1/system/health"),
    );
    const accumulator = new Headers();
    accumulator.set("content-type", "application/json");
    context.set("headers", accumulator);
    assert.strictEqual(demand(context, "headers"), accumulator);
  });

  it("an optional read of an absent body variable is undefined", () => {
    const context = new Context<AppEnv>(
      new Request("https://kanthord.invalid/v1/graph/import"),
    );
    assert.strictEqual(optional(context, "body"), undefined);
  });

  it("an optional read after a body write returns the exact written value", () => {
    const context = new Context<AppEnv>(
      new Request("https://kanthord.invalid/v1/graph/import"),
    );
    const body = { plan: "plan_01" };
    context.set("body", body);
    assert.strictEqual(optional(context, "body"), body);
  });
});
