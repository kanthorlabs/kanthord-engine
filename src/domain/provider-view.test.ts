import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ProviderView } from "./provider-view.ts";

const fixture: ProviderView = {
  id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
  name: "kanthord-default",
  kind: "llm",
  projection: null,
  setDefaultAt: null,
  updatedAt: 1700000000000,
};

describe("src/domain/provider-view.test", () => {
  it("a fixture with a null projection carries exactly the six public keys in bytewise order", () => {
    const keys = Object.keys(fixture).sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    assert.deepEqual(keys, [
      "id",
      "kind",
      "name",
      "projection",
      "setDefaultAt",
      "updatedAt",
    ]);
  });

  it("the provider view module resolves at the domain seam", async () => {
    await import("./provider-view.ts");
  });
});
