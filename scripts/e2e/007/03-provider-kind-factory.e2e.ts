import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadE2eEnv } from "../env.ts";
import {
  deserializePayload,
  parsePayload,
  projectPayload,
  serializePayload,
} from "../../../src/domain/provider-payload.ts";

describe("scripts/e2e/007/03-provider-kind-factory.e2e", () => {
  it("E7-03 — the factory round-trips the real token with no network call", () => {
    const env = loadE2eEnv();
    assert.ok(env.ghToken.length > 0);

    const payload = parsePayload("git", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token: env.ghToken,
    });
    const bytes = serializePayload("git", payload);
    assert.deepEqual(JSON.parse(bytes), payload);
    assert.equal(
      serializePayload("git", deserializePayload("git", bytes)),
      bytes,
    );

    const projection = projectPayload("git", payload);
    assert.deepEqual(projection, {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
    });
    assert.ok(!JSON.stringify(projection).includes(env.ghToken));
  });
});
