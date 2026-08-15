import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import type { Storage } from "../../services/storage/index.ts";
import type { Secret } from "../../services/secret/index.ts";
import { NodeCryptoSecret } from "../../services/secret/node-crypto.ts";
import type { ActorRow } from "../../domain/actor.ts";
import { bootstrapActorId, renderActorToken } from "../../domain/actor.ts";
import { resolveActor } from "./resolve-actor.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";

const CONFIGURED_TOKEN = "test-token";
const DOT_TOKEN = "abc.def";
const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const ULID_B = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const ACTOR_A = `actor_${ULID_A}`;
const ACTOR_B = `actor_${ULID_B}`;
const SECRET_A = "a".repeat(43);
const SECRET_B = "b".repeat(43);
const CREATED_AT = 1700000000000;

class CountingSecret implements Secret {
  readonly calls: Array<
    Readonly<{ expected: Uint8Array; presented: Uint8Array }>
  > = [];
  private readonly delegate = new NodeCryptoSecret();

  generate(): string {
    return this.delegate.generate();
  }

  digest(secret: string): Uint8Array {
    return this.delegate.digest(secret);
  }

  matches(expected: Uint8Array, presented: Uint8Array): boolean {
    this.calls.push({ expected, presented });
    return this.delegate.matches(expected, presented);
  }
}

function seedActor(
  storage: Storage,
  input: Readonly<{
    id: string;
    kind: string;
    name: string;
    secret: string;
    revokedAt?: number;
  }>,
): Uint8Array {
  const digest = new NodeCryptoSecret().digest(input.secret);
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        input.id,
        input.kind,
        input.name,
        digest,
        bootstrapActorId,
        CREATED_AT,
        input.revokedAt ?? null,
        input.revokedAt === undefined ? null : bootstrapActorId,
      ],
    ),
  );
  return digest;
}

function resolve(
  storage: Storage,
  secret: Secret,
  configuredToken: string,
  presented: string,
): ActorRow | null {
  return resolveActor({ storage, secret, configuredToken }, { presented });
}

describe("src/queries/actor/resolve-actor.test", () => {
  it("a presented value equal to a non-empty configured token resolves the bootstrap row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const result = resolve(
      temporary.storage,
      new CountingSecret(),
      CONFIGURED_TOKEN,
      CONFIGURED_TOKEN,
    );
    assert.ok(result !== null);
    assert.equal(result.id, bootstrapActorId);
    assert.equal(result.kind, "human");
  });

  it("a configured token that contains a dot resolves the bootstrap row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const result = resolve(
      temporary.storage,
      new CountingSecret(),
      DOT_TOKEN,
      DOT_TOKEN,
    );
    assert.ok(result !== null);
    assert.equal(result.id, bootstrapActorId);
    assert.equal(result.kind, "human");
  });

  it("a configured token that is a well-formed actor token string still resolves the bootstrap row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const configured = renderActorToken({
      actorId: ACTOR_A,
      secret: SECRET_A,
    });
    const result = resolve(
      temporary.storage,
      new CountingSecret(),
      configured,
      configured,
    );
    assert.ok(result !== null);
    assert.equal(result.id, bootstrapActorId);
    assert.equal(result.kind, "human");
  });

  it("with an empty configured token every presented value resolves the bootstrap row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new CountingSecret();
    for (const presented of [
      renderActorToken({ actorId: ACTOR_A, secret: SECRET_A }),
      "",
      "malformed-value",
    ]) {
      const result = resolve(temporary.storage, secret, "", presented);
      assert.ok(result !== null, `expected ${presented} to resolve`);
      assert.equal(result.id, bootstrapActorId);
      assert.equal(result.kind, "human");
    }
    assert.equal(secret.calls.length, 0);
  });

  it("a registered non-revoked actor's token resolves that row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedActor(temporary.storage, {
      id: ACTOR_A,
      kind: "harness",
      name: "harness-a",
      secret: SECRET_A,
    });
    const result = resolve(
      temporary.storage,
      new CountingSecret(),
      CONFIGURED_TOKEN,
      renderActorToken({ actorId: ACTOR_A, secret: SECRET_A }),
    );
    assert.ok(result !== null);
    assert.equal(result.id, ACTOR_A);
    assert.equal(result.kind, "harness");
    assert.equal(result.name, "harness-a");
  });

  it("a token whose secret is wrong for a real id returns null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedActor(temporary.storage, {
      id: ACTOR_A,
      kind: "harness",
      name: "harness-a",
      secret: SECRET_A,
    });
    assert.equal(
      resolve(
        temporary.storage,
        new CountingSecret(),
        CONFIGURED_TOKEN,
        renderActorToken({ actorId: ACTOR_A, secret: SECRET_B }),
      ),
      null,
    );
  });

  it("a token whose actor id is well formed but absent returns null and compares the dummy digest once", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new CountingSecret();
    assert.equal(
      resolve(
        temporary.storage,
        secret,
        CONFIGURED_TOKEN,
        renderActorToken({ actorId: ACTOR_B, secret: SECRET_A }),
      ),
      null,
    );
    const dummyCalls = secret.calls.filter(
      (call) => Buffer.compare(call.expected, new Uint8Array(32)) === 0,
    );
    assert.equal(dummyCalls.length, 1);
  });

  it("a token for a revoked actor returns null and the compare runs against the stored digest", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const storedDigest = seedActor(temporary.storage, {
      id: ACTOR_A,
      kind: "harness",
      name: "harness-a",
      secret: SECRET_A,
      revokedAt: CREATED_AT + 1,
    });
    const secret = new CountingSecret();
    assert.equal(
      resolve(
        temporary.storage,
        secret,
        CONFIGURED_TOKEN,
        renderActorToken({ actorId: ACTOR_A, secret: SECRET_A }),
      ),
      null,
    );
    const storedCalls = secret.calls.filter(
      (call) => Buffer.compare(call.expected, storedDigest) === 0,
    );
    assert.equal(storedCalls.length, 1);
  });

  it("the unknown-id and wrong-secret failure paths perform the same number of matches calls", (t) => {
    const unknown = createMigratedStorage();
    t.after(() => unknown.dispose());
    const wrong = createMigratedStorage();
    t.after(() => wrong.dispose());
    const unknownSecret = new CountingSecret();
    const wrongSecret = new CountingSecret();
    seedActor(wrong.storage, {
      id: ACTOR_A,
      kind: "harness",
      name: "harness-a",
      secret: SECRET_A,
    });

    assert.equal(
      resolve(
        unknown.storage,
        unknownSecret,
        CONFIGURED_TOKEN,
        renderActorToken({ actorId: ACTOR_B, secret: SECRET_A }),
      ),
      null,
    );
    assert.equal(
      resolve(
        wrong.storage,
        wrongSecret,
        CONFIGURED_TOKEN,
        renderActorToken({ actorId: ACTOR_A, secret: SECRET_B }),
      ),
      null,
    );
    assert.equal(unknownSecret.calls.length, wrongSecret.calls.length);
  });

  it("a value with no dot, a provider_ prefix, a 42-character secret or an empty string returns null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new CountingSecret();
    for (const presented of [
      "no-dot",
      `provider_${ULID_A}.${SECRET_A}`,
      `${ACTOR_A}.${"a".repeat(42)}`,
      "",
    ]) {
      assert.equal(
        resolve(temporary.storage, secret, CONFIGURED_TOKEN, presented),
        null,
        `expected ${presented} to be refused`,
      );
    }
  });

  it("the bootstrap actor id presented as a token returns null under a non-empty configured token", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    assert.equal(
      resolve(
        temporary.storage,
        new CountingSecret(),
        CONFIGURED_TOKEN,
        renderActorToken({ actorId: bootstrapActorId, secret: SECRET_A }),
      ),
      null,
    );
  });

  it("does not throw for any rejection input", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedActor(temporary.storage, {
      id: ACTOR_A,
      kind: "harness",
      name: "harness-a",
      secret: SECRET_A,
    });
    const secret = new CountingSecret();
    const rejections = [
      "no-dot",
      `provider_${ULID_A}.${SECRET_A}`,
      `${ACTOR_A}.${"a".repeat(42)}`,
      "",
      renderActorToken({ actorId: bootstrapActorId, secret: SECRET_A }),
      renderActorToken({ actorId: ACTOR_B, secret: SECRET_A }),
      renderActorToken({ actorId: ACTOR_A, secret: SECRET_B }),
    ];
    for (const presented of rejections) {
      assert.doesNotThrow(() =>
        resolve(temporary.storage, secret, CONFIGURED_TOKEN, presented),
      );
    }
  });
});
