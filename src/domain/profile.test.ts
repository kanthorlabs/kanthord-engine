import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { profileRow } from "./profile.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const ULID_B = "01HZY8QF3M4N5P6R7S8T9V0W2Y";
const HASH = "sha256:" + "0".repeat(64);

describe("src/domain/profile.test", () => {
  const validProfile = {
    id: "profile_" + ULID_A,
    repositoryId: "repo_" + ULID_B,
    contentBlob: HASH,
    updatedAt: 0,
  };

  it("accepts a valid profile row", () => {
    assert.equal(profileRow.safeParse(validProfile).success, true);
  });

  it("Object.keys(profileRow.shape) deep-equals the four keys in order", () => {
    assert.deepEqual(Object.keys(profileRow.shape), [
      "id",
      "repositoryId",
      "contentBlob",
      "updatedAt",
    ]);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validProfile)) {
      const copy = { ...validProfile };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        profileRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects repo_ prefix for id", () => {
    assert.equal(
      profileRow.safeParse({ ...validProfile, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects profile_ prefix for repositoryId", () => {
    assert.equal(
      profileRow.safeParse({
        ...validProfile,
        repositoryId: "profile_" + ULID_B,
      }).success,
      false,
    );
  });

  it("rejects contentBlob without sha256: prefix", () => {
    assert.equal(
      profileRow.safeParse({
        ...validProfile,
        contentBlob: "0".repeat(64),
      }).success,
      false,
    );
  });

  it("extra checks key is stripped by zod passthrough", () => {
    const withChecks = { ...validProfile, checks: { foo: "bar" } };
    const result = profileRow.safeParse(withChecks);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(result.data, "checks"),
        false,
        "expected parsed result to have no checks key",
      );
    }
  });
});
