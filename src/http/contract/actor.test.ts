import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderPath } from "./path.ts";
import {
  actor,
  actorRegisterRequest,
  actorRegisterResponse,
  actorTokenPattern,
  actorView,
} from "./actor.ts";
import {
  bootstrapActorId,
  parseActorToken,
  renderActorToken,
} from "../../domain/actor.ts";

const VALID_ULID = "01JQ8Z7G3HZZZZZZZZZZZZZZZZ";
const SECRET = "abc-def_ghijklmnopqrstuvwxyzABCDEFGHIJKLMNo";

const wholeToken = (actorId: string): string =>
  renderActorToken({ actorId, secret: SECRET });

const actorViewBody = {
  id: bootstrapActorId,
  kind: "harness",
  name: "a",
  registeredBy: bootstrapActorId,
  createdAt: 0,
  revokedAt: null,
  revokedBy: null,
};

describe("src/http/contract/actor.test", () => {
  it("declares the five rows with the exact method and rendered path", () => {
    const expected = [
      ["actor.register", "POST", "/v1/actor"],
      ["actor.list", "GET", "/v1/actor"],
      ["actor.show", "GET", "/v1/actor/:id"],
      ["actor.revoke", "POST", "/v1/actor/:id/revoke"],
      ["actor.rotate", "POST", "/v1/actor/:id/rotate"],
    ] as const;
    assert.equal(actor.length, 5);
    for (const [operationId, method, path] of expected) {
      const entry = actor.find(
        (candidate) => candidate.operationId === operationId,
      );
      assert.ok(entry !== undefined, `${operationId} is declared`);
      assert.equal(entry.method, method, operationId);
      assert.equal(renderPath(entry.path), path, operationId);
    }
  });

  it("declares allowedActors deep-equal to human on all five rows", () => {
    for (const entry of actor) {
      assert.deepEqual(entry.allowedActors, ["human"], entry.operationId);
    }
  });

  it("declares memory idempotency and replayable 200 on the three POST rows and none on the GET rows", () => {
    for (const entry of actor) {
      if (entry.method === "POST") {
        assert.equal(entry.idempotency, "memory", entry.operationId);
        assert.deepEqual(entry.replayable, [200], entry.operationId);
      } else {
        assert.equal(entry.idempotency, undefined, entry.operationId);
      }
    }
  });

  it("actorRegisterRequest rejects a kind key, an uppercase name, a leading hyphen and a 64-character name, and accepts a 63-character name", () => {
    assert.equal(
      actorRegisterRequest.safeParse({ name: "a", kind: "harness" }).success,
      false,
    );
    assert.equal(
      actorRegisterRequest.safeParse({ name: "HarnessA" }).success,
      false,
    );
    assert.equal(
      actorRegisterRequest.safeParse({ name: "-harness" }).success,
      false,
    );
    assert.equal(
      actorRegisterRequest.safeParse({ name: "a".repeat(64) }).success,
      false,
    );
    assert.equal(
      actorRegisterRequest.safeParse({ name: "a".repeat(63) }).success,
      true,
    );
  });

  it("actorRegisterResponse accepts a whole token and rejects a bare secret", () => {
    assert.equal(
      actorRegisterResponse.safeParse({
        ...actorViewBody,
        token: wholeToken(bootstrapActorId),
      }).success,
      true,
    );
    assert.equal(
      actorRegisterResponse.safeParse({ ...actorViewBody, token: SECRET })
        .success,
      false,
    );
  });

  it("keeps actorTokenPattern in lockstep with the domain token grammar", () => {
    const bootstrapToken = wholeToken(bootstrapActorId);
    const registeredToken = wholeToken(`actor_${VALID_ULID}`);
    assert.equal(actorTokenPattern.test(bootstrapToken), true);
    assert.equal(actorTokenPattern.test(registeredToken), true);
    assert.ok(parseActorToken(bootstrapToken) !== null);
    assert.ok(parseActorToken(registeredToken) !== null);
    for (const secret of [SECRET.slice(0, 42), `${SECRET}x`]) {
      const token = renderActorToken({ actorId: bootstrapActorId, secret });
      assert.equal(actorTokenPattern.test(token), false);
      assert.equal(parseActorToken(token), null);
    }
  });

  it("actorView rejects a token key and a tokenSha256 key", () => {
    assert.equal(actorView.safeParse(actorViewBody).success, true);
    assert.equal(
      actorView.safeParse({
        ...actorViewBody,
        token: wholeToken(bootstrapActorId),
      }).success,
      false,
    );
    assert.equal(
      actorView.safeParse({ ...actorViewBody, tokenSha256: "x" }).success,
      false,
    );
  });
});
