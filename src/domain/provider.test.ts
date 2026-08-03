import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { providerRow } from "./provider.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/domain/provider.test", () => {
  const validRow = {
    id: "provider_" + ULID_A,
    name: "test-provider",
    kind: "llm" as const,
    setDefaultAt: null,
    payloadCiphertext: new Uint8Array(3),
    payloadIv: new Uint8Array(12),
    payloadTag: new Uint8Array(16),
    keyVersion: 1,
    updatedAt: 0,
  };

  it("accepts a valid row", () => {
    assert.equal(providerRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        providerRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      providerRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("accepts kind llm", () => {
    assert.equal(
      providerRow.safeParse({ ...validRow, kind: "llm" }).success,
      true,
    );
  });

  it("accepts kind git", () => {
    assert.equal(
      providerRow.safeParse({ ...validRow, kind: "git" }).success,
      true,
    );
  });

  it("rejects invalid kind", () => {
    assert.equal(
      providerRow.safeParse({ ...validRow, kind: "invalid" }).success,
      false,
    );
  });

  it("rejects payloadIv length 11", () => {
    assert.equal(
      providerRow.safeParse({
        ...validRow,
        payloadIv: new Uint8Array(11),
      }).success,
      false,
    );
  });

  it("rejects payloadIv length 13", () => {
    assert.equal(
      providerRow.safeParse({
        ...validRow,
        payloadIv: new Uint8Array(13),
      }).success,
      false,
    );
  });

  it("refine: payloadIv message equals the DDL CHECK expression", () => {
    const result = providerRow.safeParse({
      ...validRow,
      payloadIv: new Uint8Array(11),
    });
    assert.equal(result.success, false);
    assert.equal(result.error!.issues[0]!.message, "length(payload_iv) = 12");
  });

  it("accepts payloadIv length 12", () => {
    assert.equal(
      providerRow.safeParse({
        ...validRow,
        payloadIv: new Uint8Array(12),
      }).success,
      true,
    );
  });

  it("rejects payloadTag length 15", () => {
    assert.equal(
      providerRow.safeParse({
        ...validRow,
        payloadTag: new Uint8Array(15),
      }).success,
      false,
    );
  });

  it("rejects payloadTag length 17", () => {
    assert.equal(
      providerRow.safeParse({
        ...validRow,
        payloadTag: new Uint8Array(17),
      }).success,
      false,
    );
  });

  it("refine: payloadTag message equals the DDL CHECK expression", () => {
    const result = providerRow.safeParse({
      ...validRow,
      payloadTag: new Uint8Array(15),
    });
    assert.equal(result.success, false);
    assert.equal(result.error!.issues[0]!.message, "length(payload_tag) = 16");
  });

  it("accepts payloadTag length 16", () => {
    assert.equal(
      providerRow.safeParse({
        ...validRow,
        payloadTag: new Uint8Array(16),
      }).success,
      true,
    );
  });
});
