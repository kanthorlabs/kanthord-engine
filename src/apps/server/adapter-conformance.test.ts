import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import {
  AccessPolicy,
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { isObject, isString, ValueType } from "../../kernel/values.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_WORKER_BINDING,
  TEST_PROJECT_ID,
} from "./test-support.ts";

const MAX_WIRE_NODES = 10000;
const NO_SYMBOL_KEYS = 0;
const input = { params: {}, query: {}, body: null };

function assertWireData(data: unknown): void {
  const values = [data];
  for (
    let index = 0;
    index < values.length && index < MAX_WIRE_NODES;
    index++
  ) {
    const value = values[index];
    if (!isObject(value)) {
      assert.ok(
        value === null ||
          [ValueType.String, ValueType.Boolean, ValueType.Number].some(
            (type) => typeof value === type,
          ),
      );
      if (typeof value === ValueType.Number) assert.ok(Number.isFinite(value));
      continue;
    }
    assert.ok(!(value instanceof Response));
    assert.ok(!(value instanceof DatabaseSync));
    assert.ok(
      [Object.prototype, Array.prototype, null].includes(
        Object.getPrototypeOf(value),
      ),
    );
    assert.equal(Object.getOwnPropertySymbols(value).length, NO_SYMBOL_KEYS);
    const children = Object.values(value);
    assert.ok(values.length + children.length <= MAX_WIRE_NODES);
    values.push(...children);
  }
  assert.ok(values.length <= MAX_WIRE_NODES);
}

function assertEquivalent(
  left: OperationResult<unknown>,
  right: OperationResult<unknown>,
): void {
  assert.equal(left.type, right.type);
  assert.notEqual(left.type, OperationResultType.Indeterminate);
  assert.notEqual(right.type, OperationResultType.Indeterminate);
  if (
    left.type === OperationResultType.Indeterminate ||
    right.type === OperationResultType.Indeterminate
  )
    return;
  assert.equal(left.status, right.status);
  if (
    left.type === OperationResultType.Failure &&
    right.type === OperationResultType.Failure
  )
    assert.equal(left.error.error.code, right.error.error.code);
  if (
    left.type === OperationResultType.Completed &&
    right.type === OperationResultType.Completed
  ) {
    assertWireData(left.data);
    assertWireData(right.data);
    assert.deepEqual(left.data, right.data);
  }
}

test("every composed operation conforms across direct and HTTP adapters", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const machineToken = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  for (const { operation } of fixture.gateway.registry.all()) {
    await t.test(operation.id, async () => {
      const token =
        operation.access === AccessPolicy.Client ? machineToken : fixture.token;
      const identity = await fixture.gateway.authentication.authenticate(
        `Bearer ${token}`,
      );
      const direct = directClient({ operation }, fixture.gateway.invocation);
      const http = httpClient({ operation }, fixture.endpoint, token);
      assertEquivalent(
        await direct.operation({ malformed: true }, { identity }),
        await http.operation({ malformed: true }),
      );
      if (!operation.input.safeParse(input).success) return;
      assertEquivalent(
        await direct.operation(input, { identity }),
        await http.operation(input),
      );
    });
  }
});

test("HTTP against a closed port is indeterminate", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && !isString(address));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const result = await httpClient(
    gatewayOperations,
    `http://127.0.0.1:${address.port}`,
  ).liveness(input);
  assert.equal(result.type, OperationResultType.Indeterminate);
});

test("the wire walk rejects functions, responses, transactions and class instances", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const value of [
      () => {},
      new Response(),
      { database },
      new Date(),
      { nested: { callback: () => {} } },
    ])
      assert.throws(() => assertWireData(value));
    assert.doesNotThrow(() =>
      assertWireData({ nested: [null, true, 1, "value"] }),
    );
  } finally {
    database.close();
  }
});
