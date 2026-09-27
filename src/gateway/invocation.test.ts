import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { MASTER_KEY_BYTES } from "../config/global.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  emptyInput,
  OperationLifetime,
  OperationRegistry,
  StoreName,
} from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import { createInvocation, gatewayMigrations } from "./index.ts";
import { generateHumanJWT } from "./local.ts";

const operation = {
  id: "test.commit.read",
  service: "test",
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  method: "GET",
  path: "/api/test/commit",
  access: AccessPolicy.Human,
  timeoutMs: 30000,
  mutation: false,
  input: emptyInput,
  output: z.number(),
  status: HttpStatus.OK,
  description: "Read a value inside a transaction.",
} as const;
const input = { params: {}, query: {}, body: null };
const COMMITTED_VALUE = 42;

async function fixture(t: TestContext, registry: OperationRegistry) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  registry.seal({ [StoreName.Operational]: store });
  const masterKey = randomBytes(MASTER_KEY_BYTES).toString("base64");
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey,
    tokenLifetime: 600,
  });
  t.after(() => invocation.stop());
  const { token } = await generateHumanJWT(masterKey, 600);
  return { invocation, token };
}

test("read operation commits once", async (t) => {
  const registry = new OperationRegistry();
  registry.register(operation, (_input, caller) =>
    caller.commit(({ database }) =>
      Number(database.prepare("SELECT 42 AS value").get()?.value),
    ),
  );
  const { invocation, token } = await fixture(t, registry);
  const response = await invocation.invoke(operation.id, input, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.body, COMMITTED_VALUE);
});

test("second commit throws", async (t) => {
  const registry = new OperationRegistry();
  let secondError: unknown;
  registry.register(operation, (_input, caller) => {
    caller.commit(() => 42);
    try {
      caller.commit(() => 43);
    } catch (error) {
      secondError = error;
    }
    return 42;
  });
  const { invocation, token } = await fixture(t, registry);
  await invocation.invoke(operation.id, input, {
    authorization: `Bearer ${token}`,
  });
  assert.ok(secondError instanceof Error);
  assert.match(secondError.message, /called twice/);
});
