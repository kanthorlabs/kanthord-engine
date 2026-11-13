import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  AccessPolicy,
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { isObject, isString, ValueType } from "../../kernel/values.ts";
import { fakeContainerHost } from "./container-fakes-test-support.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "./test-support.ts";

const MAX_WIRE_NODES = 10000;
const NO_SYMBOL_KEYS = 0;
const input = { params: {}, query: {}, body: null };
const MEASURED_OPERATIONS: readonly string[] = ["footprint.measure.run"];

function shapeOf(value: unknown): unknown {
  if (typeof value === ValueType.Number) return ValueType.Number;
  if (Array.isArray(value)) return value.map(shapeOf);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, shapeOf(child)]),
    );
  return value;
}

function sameData(data: unknown): unknown {
  return data;
}

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
  compared: (data: unknown) => unknown = sameData,
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
    assert.deepEqual(compared(left.data), compared(right.data));
  }
}

function assertDirectOnly(result: OperationResult<unknown>): void {
  assert.notEqual(result.type, OperationResultType.Indeterminate);
  if (result.type === OperationResultType.Completed)
    assertWireData(result.data);
  if (result.type === OperationResultType.Failure)
    assert.ok(isString(result.error.error.code));
}

test("every composed operation conforms across direct and HTTP adapters", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const fixture = await gatewayFixture(t, {
    machines: fakeMachines(),
    containerRuntimeHost: fakeContainerHost(t).host,
  });
  const machineToken = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  for (const { operation } of fixture.gateway.registry.all()) {
    if (operation.access === AccessPolicy.Service) continue;
    await t.test(operation.id, async () => {
      const token =
        operation.access === AccessPolicy.Client ? machineToken : fixture.token;
      const identity = await fixture.gateway.authentication.authenticate(
        `Bearer ${token}`,
      );
      const direct = directClient({ operation }, fixture.gateway.invocation);
      if (operation.direct) {
        assertDirectOnly(
          await direct.operation({ malformed: true }, { identity }),
        );
        if (!operation.input.safeParse(input).success) return;
        assertDirectOnly(await direct.operation(input, { identity }));
        return;
      }
      const http = httpClient({ operation }, fixture.endpoint, token);
      assertEquivalent(
        await direct.operation({ malformed: true }, { identity }),
        await http.operation({ malformed: true }),
      );
      if (!operation.input.safeParse(input).success) return;
      assertEquivalent(
        await direct.operation(input, { identity }),
        await http.operation(input),
        MEASURED_OPERATIONS.includes(operation.id) ? shapeOf : sameData,
      );
    });
  }
});
