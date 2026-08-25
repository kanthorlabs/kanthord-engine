import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Context } from "hono";

import { headersMiddleware } from "./headers.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

describe("src/http/server/headers.test", () => {
  it("each downstream frame reads the one accumulator this middleware seeded", async () => {
    const context = new Context<AppEnv>(
      new Request("https://kanthord.invalid/v1/system/health"),
    );
    let calls = 0;
    let downstream: Headers | undefined;
    await headersMiddleware()(context, async () => {
      calls += 1;
      downstream = demand(context, "headers");
    });
    assert.strictEqual(calls, 1);
    assert.ok(downstream instanceof Headers);
    assert.strictEqual(demand(context, "headers"), downstream);
  });

  it("a second invocation seeds an accumulator that no earlier invocation owns", async () => {
    const first = new Context<AppEnv>(
      new Request("https://kanthord.invalid/v1/system/health"),
    );
    const second = new Context<AppEnv>(
      new Request("https://kanthord.invalid/v1/graph/import"),
    );
    const seeded: Headers[] = [];
    for (const context of [first, second]) {
      await headersMiddleware()(context, async () => {
        seeded.push(demand(context, "headers"));
      });
    }
    assert.ok(seeded[0] instanceof Headers);
    assert.ok(seeded[1] instanceof Headers);
    assert.notStrictEqual(seeded[0], seeded[1]);
  });
});
