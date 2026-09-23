import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, sign } from "hono/jwt";
import { ulid } from "ulid";
import { background } from "../context.ts";
import { deriveKey } from "../shared/json.ts";
import { identitySchema } from "../shared/identity.ts";
import { HttpStatus } from "../shared/http.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_WORKER_BINDING,
} from "../test-support.ts";
import {
  CLIENT_IDENTITY_PREFIX,
  IdentityKind,
  MAX_BINDING_ID_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_HUMAN_USERNAME_LENGTH,
} from "./constants.ts";
import {
  generateHumanJWT,
  generateMachineJWT,
  isHumanIdentity,
  isMachineIdentity,
} from "./authentication.ts";
import { gatewayOperations } from "./operations.ts";
import { workerOperations } from "../worker/operations.ts";

const TOKEN_LIFETIME = 600;
const MILLISECONDS_PER_SECOND = 1000;
const NO_REGISTRATIONS = 0;
const HUMAN_NAME = " Ulrich ";
const MACHINE_NAME = "Worker display";
const HUMAN_USERNAME = " ulrich ";

async function tokenKey(masterKey: string) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(deriveKey(masterKey, "gateway/jwt-hs256/v1")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

test("issuance preserves human subjects and names, and generates fresh machine subjects and session identifiers", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const human = await generateHumanJWT(
    fixture.config.masterKey,
    TOKEN_LIFETIME,
    HUMAN_USERNAME,
    HUMAN_NAME,
  );
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${human.token}`,
  );
  assert.ok(isHumanIdentity(identity));
  assert.equal(identity.accountId, HUMAN_USERNAME);
  assert.equal(identity.name, HUMAN_NAME);
  const response = await fixture.request(gatewayOperations.verify.path, {
    headers: { Authorization: `Bearer ${human.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(await response.json(), {
    kind: IdentityKind.Human,
    accountId: HUMAN_USERNAME,
    name: HUMAN_NAME,
  });
  const rechecked = await fixture.gateway.authentication.recheck(
    identity,
    background,
  );
  assert.deepEqual(rechecked, identity);
  assert.notEqual(rechecked, identity);
  const machine = await generateMachineJWT(
    fixture.config.masterKey,
    TOKEN_LIFETIME,
    TEST_WORKER_BINDING,
  );
  const named = await fixture.machineToken(TEST_WORKER_BINDING, MACHINE_NAME);
  const claims = decode(machine.token).payload;
  const other = decode(named).payload;
  assert.ok(
    identitySchema(CLIENT_IDENTITY_PREFIX).safeParse(claims.sub).success,
  );
  assert.equal(claims.name, claims.sub);
  assert.equal(claims.kind, IdentityKind.Client);
  assert.equal(claims.binding, TEST_WORKER_BINDING);
  assert.equal(claims.exp! - claims.iat!, TOKEN_LIFETIME);
  assert.equal(machine.expiresAt, claims.exp! * MILLISECONDS_PER_SECOND);
  assert.notEqual(claims.sub, other.sub);
  assert.notEqual(claims.jti, other.jti);
  const verified = await fixture.gateway.authentication.authenticate(
    `Bearer ${named}`,
  );
  assert.ok(isMachineIdentity(verified));
  assert.equal(verified.name, MACHINE_NAME);
  assert.equal(verified.runtimeIdentity, undefined);
  assert.ok(Object.isFrozen(verified));
});

test("both token kinds reject invalid names, timestamps, session identifiers, signatures, algorithms and kinds", async (t) => {
  const machines = fakeMachines();
  const fixture = await gatewayFixture(t, { machines });
  const key = await tokenKey(fixture.config.masterKey);
  const tokens = [
    fixture.token,
    await fixture.machineToken(TEST_WORKER_BINDING),
  ];
  const invalidClaims: Record<string, unknown>[] = [
    { name: undefined },
    { name: "" },
    { name: " \t" },
    { name: "n".repeat(MAX_DISPLAY_NAME_LENGTH + 1) },
    { name: 1 },
    { jti: undefined },
    { jti: 1 },
    { iat: undefined },
    { iat: 1.5 },
    { iat: Number.MAX_SAFE_INTEGER + 1 },
    { iat: "1" },
    { exp: undefined },
    { exp: 1.5 },
    { exp: Number.MAX_SAFE_INTEGER + 1 },
    { exp: "9999999999" },
    { exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) },
    { kind: "unknown" },
    { kind: undefined },
  ];
  for (const token of tokens) {
    const claims = decode(token).payload;
    for (const changes of invalidClaims) {
      const invalid = await sign({ ...claims, ...changes }, key, "HS256");
      await assert.rejects(
        fixture.gateway.authentication.authenticate(`Bearer ${invalid}`),
        /Authentication required/,
      );
    }
    const wrongAlgorithm = await sign(claims, "test-algorithm-key", "HS512");
    await assert.rejects(
      fixture.gateway.authentication.authenticate(`Bearer ${wrongAlgorithm}`),
      /Authentication required/,
    );
    await assert.rejects(
      fixture.gateway.authentication.authenticate(
        `Bearer ${token.slice(0, -3)}AAA`,
      ),
      /Authentication required/,
    );
    for (const authorization of [
      undefined,
      "Basic invalid",
      `Bearer ${token},${token}`,
      `Bearer ${token} extra`,
    ])
      await assert.rejects(
        fixture.gateway.authentication.authenticate(authorization),
        /Authentication required/,
      );
  }
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
});

test("human and machine claims enforce distinct subjects and binding rules", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const key = await tokenKey(fixture.config.masterKey);
  const human = decode(fixture.token).payload;
  const machine = decode(
    await fixture.machineToken(TEST_WORKER_BINDING),
  ).payload;
  const invalidHuman: Record<string, unknown>[] = [
    { sub: undefined },
    { sub: "" },
    { sub: " " },
    { sub: 123 },
    { sub: "u".repeat(MAX_HUMAN_USERNAME_LENGTH + 1) },
    { binding: TEST_WORKER_BINDING },
    { binding: null },
    { reg: "removed-claim" },
  ];
  const invalidMachine: Record<string, unknown>[] = [
    { binding: undefined },
    { binding: "" },
    { binding: " " },
    { binding: 123 },
    { binding: "b".repeat(MAX_BINDING_ID_LENGTH + 1) },
    { sub: undefined },
    { sub: ulid() },
    { sub: `project_${ulid()}` },
    { sub: String(machine.sub).toLowerCase() },
    { sub: 123 },
  ];
  for (const [base, invalid] of [
    [human, invalidHuman],
    [machine, invalidMachine],
  ] as const) {
    for (const changes of invalid) {
      const token = await sign({ ...base, ...changes }, key, "HS256");
      await assert.rejects(
        fixture.gateway.authentication.authenticate(`Bearer ${token}`),
        /Authentication required/,
      );
    }
    const token = await sign(
      { ...base, name: "n".repeat(MAX_DISPLAY_NAME_LENGTH) },
      key,
      "HS256",
    );
    assert.equal(
      (await fixture.gateway.authentication.authenticate(`Bearer ${token}`))
        .name.length,
      MAX_DISPLAY_NAME_LENGTH,
    );
  }
  for (const value of ["", " ", "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)]) {
    await assert.rejects(
      generateHumanJWT(
        fixture.config.masterKey,
        TOKEN_LIFETIME,
        HUMAN_USERNAME,
        value,
      ),
      /name:/,
    );
    await assert.rejects(
      generateMachineJWT(
        fixture.config.masterKey,
        TOKEN_LIFETIME,
        TEST_WORKER_BINDING,
        value,
      ),
      /name:/,
    );
  }
  await assert.rejects(
    generateMachineJWT(fixture.config.masterKey, TOKEN_LIFETIME, " "),
    /binding:/,
  );
});

test("expired and banned human and machine JWTs fail HTTP and banned direct identities fail before validation", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const key = await tokenKey(fixture.config.masterKey);
  for (const token of [
    fixture.token,
    await fixture.machineToken(TEST_WORKER_BINDING),
  ]) {
    const identity = await fixture.gateway.authentication.authenticate(
      `Bearer ${token}`,
    );
    const claims = decode(token).payload;
    const operation = isHumanIdentity(identity)
      ? gatewayOperations.verify
      : workerOperations.register;
    const expired = await sign(
      { ...claims, exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) - 1 },
      key,
      "HS256",
    );
    fixture.gateway.authentication.ban(
      identity.jti,
      claims.exp! * MILLISECONDS_PER_SECOND,
    );
    for (const invalid of [expired, token]) {
      const response = await fixture.request(operation.path, {
        method: operation.method,
        headers: {
          Authorization: `Bearer ${invalid}`,
          "Idempotency-Key": ulid(),
        },
      });
      assert.equal(response.status, HttpStatus.Unauthorized);
    }
    const direct = await fixture.gateway.invocation.invoke(
      operation.id,
      { invalid: true },
      { identity },
    );
    assert.equal(direct.status, HttpStatus.Unauthorized);
    await assert.rejects(
      fixture.gateway.authentication.recheck(identity, background),
      /Authentication required/,
    );
  }
});

test("binding collaborator failures propagate instead of becoming invalid credentials", async (t) => {
  const machines = fakeMachines();
  const failure = new Error("binding lookup failed");
  t.mock.method(machines.project, "resolveWorkerBinding", async () => {
    throw failure;
  });
  const fixture = await gatewayFixture(t, { machines });
  const token = await fixture.machineToken(TEST_WORKER_BINDING);
  await assert.rejects(
    fixture.gateway.authentication.authenticate(`Bearer ${token}`),
    (error) => error === failure,
  );
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
});
