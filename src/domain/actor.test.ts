import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  registeredActorKinds,
  bootstrapActorId,
  actorNamePattern,
  actorSecretPattern,
  actorRow,
  parseActorToken,
  renderActorToken,
} from "./actor.ts";
import { parseIdentity } from "./identity.ts";

const ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const SECRET_43 = "a".repeat(43);

describe("src/domain/actor.test", () => {
  it("registeredActorKinds deep-equals human and harness in that order", () => {
    assert.deepEqual(registeredActorKinds, ["human", "harness"]);
  });

  it("bootstrapActorId is the literal actor_ plus 26 zeros and parses as an actor identity", () => {
    assert.equal(bootstrapActorId, "actor_00000000000000000000000000");
    assert.equal(bootstrapActorId.length, 32);
    const parsed = parseIdentity(bootstrapActorId);
    assert.notEqual(parsed, null);
    assert.equal(parsed?.kind, "actor");
  });

  it("actorNamePattern accepts a, harness-1, 63 a's and 0abc", () => {
    for (const name of ["a", "harness-1", "a".repeat(63), "0abc"]) {
      assert.equal(
        actorNamePattern.test(name),
        true,
        `expected ${name} to be accepted`,
      );
    }
  });

  it("actorNamePattern rejects A, -a, a_b, the empty string and 64 a's", () => {
    for (const name of ["A", "-a", "a_b", "", "a".repeat(64)]) {
      assert.equal(
        actorNamePattern.test(name),
        false,
        `expected ${name} to be rejected`,
      );
    }
  });

  it("actorSecretPattern accepts a 43-character base64url string", () => {
    assert.equal(actorSecretPattern.test(SECRET_43), true);
  });

  it("actorSecretPattern rejects a 42- and a 44-character string", () => {
    assert.equal(actorSecretPattern.test("a".repeat(42)), false);
    assert.equal(actorSecretPattern.test("a".repeat(44)), false);
  });

  it("actorSecretPattern rejects +, / and =", () => {
    for (const character of ["+", "/", "="]) {
      const value = "a".repeat(21) + character + "a".repeat(21);
      assert.equal(value.length, 43);
      assert.equal(
        actorSecretPattern.test(value),
        false,
        `expected ${character} to be rejected`,
      );
    }
  });

  const validRow = {
    id: bootstrapActorId,
    kind: "human",
    name: "bootstrap",
    tokenSha256: new Uint8Array(32),
    registeredBy: null,
    createdAt: 0,
    revokedAt: null,
    revokedBy: null,
  };

  it("actorRow accepts a valid row", () => {
    assert.equal(actorRow.safeParse(validRow).success, true);
  });

  it("actorRow accepts a null tokenSha256", () => {
    assert.equal(
      actorRow.safeParse({ ...validRow, tokenSha256: null }).success,
      true,
    );
  });

  it("actorRow rejects a 31-byte tokenSha256 with length(token_sha256) = 32", () => {
    const result = actorRow.safeParse({
      ...validRow,
      tokenSha256: new Uint8Array(31),
    });
    assert.equal(result.success, false);
    assert.ok(
      result.success === false &&
        result.error.issues.some(
          (issue) => issue.message === "length(token_sha256) = 32",
        ),
    );
  });

  it("actorRow rejects a provider_ id", () => {
    assert.equal(
      actorRow.safeParse({ ...validRow, id: "provider_" + ULID }).success,
      false,
    );
  });

  it("parseActorToken returns the id and the secret of a well-formed token", () => {
    assert.deepEqual(parseActorToken(`${bootstrapActorId}.${SECRET_43}`), {
      actorId: bootstrapActorId,
      secret: SECRET_43,
    });
  });

  it("parseActorToken returns null for a value with no dot", () => {
    assert.equal(parseActorToken(bootstrapActorId), null);
  });

  it("parseActorToken returns null for a provider_ prefix", () => {
    assert.equal(parseActorToken(`provider_${ULID}.${SECRET_43}`), null);
  });

  it("parseActorToken returns null for a 42-character secret", () => {
    assert.equal(
      parseActorToken(`${bootstrapActorId}.${"a".repeat(42)}`),
      null,
    );
  });

  it("parseActorToken splits on the first dot and never returns a.b as the secret", () => {
    const result = parseActorToken(`${bootstrapActorId}.a.b`);
    assert.equal(result, null);
    assert.notDeepEqual(result, { actorId: bootstrapActorId, secret: "a.b" });
  });

  it("parseActorToken throws for no input", () => {
    const cases = [
      "",
      bootstrapActorId,
      `provider_${ULID}.${SECRET_43}`,
      `${bootstrapActorId}.${"a".repeat(42)}`,
      `${bootstrapActorId}.${"a".repeat(44)}`,
      `${bootstrapActorId}.a.b`,
    ];
    for (const value of cases) {
      assert.doesNotThrow(
        () => parseActorToken(value),
        `expected no throw for ${value}`,
      );
    }
  });

  it("renderActorToken round-trips with parseActorToken", () => {
    const rendered = renderActorToken({
      actorId: bootstrapActorId,
      secret: SECRET_43,
    });
    assert.deepEqual(parseActorToken(rendered), {
      actorId: bootstrapActorId,
      secret: SECRET_43,
    });
  });
});
