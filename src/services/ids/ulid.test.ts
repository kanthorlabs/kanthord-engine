import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { UlidIdGenerator } from "./ulid.ts";
import { parseIdentity, identityKinds } from "../../domain/identity.ts";

describe("src/services/ids/ulid.test", () => {
  it('mint("project") returns a string matching the project_ ULID pattern', () => {
    const generator = new UlidIdGenerator();
    const id = generator.mint("project");
    assert.match(id, /^project_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  for (const kind of identityKinds) {
    it(`parseIdentity(generator.mint("${kind}"))?.kind equals "${kind}"`, () => {
      const generator = new UlidIdGenerator();
      const id = generator.mint(kind);
      const parsed = parseIdentity(id);
      assert.ok(parsed !== null, `parseIdentity returned null for ${id}`);
      assert.equal(parsed.kind, kind);
    });
  }
});
