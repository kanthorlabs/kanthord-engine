import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, sign } from "hono/jwt";
import { ulid } from "ulid";
import { deriveKey } from "../../kernel/json.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { isHumanIdentity } from "../../kernel/caller.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_WORKER_BINDING,
} from "./test-support.ts";
const MILLISECONDS_PER_SECOND = 1000;
async function tokenKey(masterKey: string) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(deriveKey(masterKey, "gateway/jwt-hs256/v1")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

test("expired human and machine JWTs fail HTTP", async (t) => {
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
    const response = await fixture.request(operation.path, {
      method: operation.method,
      headers: {
        Authorization: `Bearer ${expired}`,
        "Idempotency-Key": ulid(),
      },
    });
    assert.equal(response.status, HttpStatus.Unauthorized);
  }
});
