import assert from "node:assert/strict";
import { test } from "node:test";
import { directClient } from "./index.ts";
import { generateHumanJWT } from "./auth/jwt.ts";
import { gatewayOperations } from "./contract.ts";
import { IdentityKind, isServiceIdentity } from "../kernel/caller.ts";
import { FOOTPRINT_SERVICE } from "../kernel/cleanup.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import { z } from "zod";
import {
  AccessPolicy,
  emptyInput,
  OperationLifetime,
  OperationRegistry,
  OperationResultType,
  StoreName,
} from "../kernel/operation.ts";
import { HttpStatus } from "../kernel/http.ts";
import { gatewayFixture } from "./test-support.ts";

const input = { params: {}, query: {}, body: null };
const usernames = ["first-human", "second-human"];

test("one direct client forwards each call's identity without retaining a previous caller", async (t) => {
  const fixture = await gatewayFixture(t);
  const client = directClient(gatewayOperations, fixture.gateway.invocation);
  for (const username of usernames) {
    const issued = await generateHumanJWT(
      fixture.config.master_key,
      fixture.config.gateway.auth.version,
      fixture.config.gateway.auth.token_lifetime,
      username,
    );
    const identity = await fixture.gateway.authentication.authenticate(
      `Bearer ${issued.token}`,
    );
    const result = await client.verify(input, { identity });
    assert.equal(result.type, OperationResultType.Completed);
    assert.ok(result.type === OperationResultType.Completed);
    assert.deepEqual(result.data, {
      kind: IdentityKind.Human,
      sub: username,
      name: username,
    });
    for (const options of [{}, { identity: { ...identity } }]) {
      const refused = await client.verify(input, options);
      assert.equal(refused.type, OperationResultType.Failure);
      assert.ok(refused.type === OperationResultType.Failure);
      assert.equal(refused.status, HttpStatus.Unauthorized);
    }
  }
});

test("HTTP invocations forward the Host header and direct invocations forward none", async (t) => {
  const registry = new OperationRegistry();
  const operation = {
    id: "test.host",
    service: "test",
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    method: "GET",
    path: "/api/test/host",
    access: "public",
    timeoutMs: 1000,
    mutation: false,
    input: emptyInput,
    output: z.strictObject({ host: z.string().nullable() }),
    status: 200,
    description: "Expose the Host header seen by a test handler.",
  } as const;
  registry.register(operation, (_input, caller) => ({
    host: caller.host ?? null,
  }));
  const fixture = await gatewayFixture(t, { registry });
  const response = await fixture.request(operation.path);
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(operation.output.parse(await response.json()), {
    host: new URL(fixture.endpoint).host,
  });
  const result = await fixture.gateway.invocation.invoke(operation.id, input);
  assert.equal(result.status, HttpStatus.OK);
  assert.deepEqual(result.body, { host: null });
});

test("the Footprint service identity reaches a human_or_service owner handler", async (t) => {
  const registry = new OperationRegistry();
  const owner = {
    id: "test.owner_delete",
    service: "test",
    method: "POST",
    path: "/api/test/owner-delete",
    access: AccessPolicy.HumanOrService,
    services: [FOOTPRINT_SERVICE],
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: 30000,
    mutation: false,
    input: emptyInput,
    output: z.string(),
    status: HttpStatus.OK,
    description: "Answer the service of the caller.",
  } as const;
  registry.register(owner, (_input, caller) =>
    isServiceIdentity(caller.identity) ? caller.identity.service : "none",
  );
  const fixture = await gatewayFixture(t, { registry });
  const result = await directClient(
    { owner },
    fixture.gateway.invocation,
  ).owner(input, { identity: testServiceIdentity(FOOTPRINT_SERVICE) });
  assert.equal(result.type, OperationResultType.Completed);
  assert.ok(result.type === OperationResultType.Completed);
  assert.equal(result.data, FOOTPRINT_SERVICE);
});
