import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, sign } from "hono/jwt";
import { ulid } from "ulid";
import { deriveKey } from "../../kernel/json.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { isHumanIdentity, IdentityKind } from "../../kernel/caller.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { projectOperations, BindingKind } from "../../project/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { directClient } from "../../gateway/index.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_WORKER_BINDING,
  TEST_PROJECT_ID,
} from "./test-support.ts";
const MILLISECONDS_PER_SECOND = 1000;
const AFTER_REMOVAL_MS = 2000;
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
    await fixture.machineToken(TEST_PROJECT_ID, TEST_WORKER_BINDING),
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

test("a removed and rebound worker group refuses old tokens on HTTP and direct adapters", async (t) => {
  const fixture = await gatewayFixture(t);
  const projects = httpClient(
    projectOperations,
    fixture.endpoint,
    fixture.token,
  );
  const created = await projects.create({
    params: {},
    query: {},
    body: { name: "jwt-group" },
  });
  assert.ok(created.type === OperationResultType.Completed);
  const projectId = created.data.id;
  const bindings = {
    machine: {
      kind: BindingKind.Worker,
      config: { worker: "claude@1", instanceCount: 1 },
    },
  };
  const first = await projects["bindingSet.write"]({
    params: { projectId },
    query: {},
    body: { version: 1, bindings },
  });
  assert.ok(first.type === OperationResultType.Completed);
  const token = await fixture.machineToken(projectId, "machine");
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${token}`,
  );
  const removed = await projects["bindingSet.write"]({
    params: { projectId },
    query: {},
    body: { version: first.data.bindingSetVersion, bindings: {} },
  });
  assert.ok(removed.type === OperationResultType.Completed);
  const rebound = await projects["bindingSet.write"]({
    params: { projectId },
    query: {},
    body: { version: removed.data.bindingSetVersion, bindings },
  });
  assert.ok(rebound.type === OperationResultType.Completed);
  const input = { params: {}, query: {}, body: null };
  const http = await httpClient(
    workerOperations,
    fixture.endpoint,
    token,
  ).register(input);
  const direct = await directClient(
    workerOperations,
    fixture.gateway.invocation,
  ).register(input, { identity });
  for (const result of [http, direct]) {
    assert.ok(result.type === OperationResultType.Failure);
    assert.equal(result.status, HttpStatus.Unauthorized);
  }
  const freshTime = Date.now() + AFTER_REMOVAL_MS;
  const clock = t.mock.method(Date, "now", () => freshTime);
  const fresh = await fixture.machineToken(projectId, "machine");
  const freshIdentity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fresh}`,
  );
  assert.equal(freshIdentity.kind, IdentityKind.Client);
  clock.mock.restore();
});
