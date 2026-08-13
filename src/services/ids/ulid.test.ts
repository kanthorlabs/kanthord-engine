import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { UlidIdGenerator } from "./ulid.ts";
import {
  identityTime,
  parseIdentity,
  identityKinds,
} from "../../domain/identity.ts";

mock.method(Date, "now", () => 1700000000000);

describe("src/services/ids/ulid.test", () => {
  after(() => {
    mock.restoreAll();
  });

  it('mint("project") returns a string matching the project_ ULID pattern', () => {
    const generator = new UlidIdGenerator();
    const id = generator.mint("project");
    assert.match(id, /^project_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("mints two event ids in the fixed millisecond 1700000000000 in mint order", () => {
    const generator = new UlidIdGenerator();
    const first = generator.mint("event");
    const second = generator.mint("event");
    assert.equal(identityTime(first), 1700000000000);
    assert.equal(identityTime(second), 1700000000000);
    assert.equal(
      Buffer.compare(Buffer.from(first), Buffer.from(second)),
      -1,
      `expected ${first} to sort before ${second}`,
    );
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
