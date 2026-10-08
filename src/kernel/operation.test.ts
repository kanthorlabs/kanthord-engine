import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  AccessPolicy,
  StoreName,
  OperationLifetime,
  emptyInput,
  OperationRegistry,
  type Operation,
} from "./operation.ts";
import { componentHealthSchema } from "./health.ts";
import { HttpMethod, HttpStatus } from "./http.ts";
const read = {
  id: "test.read",
  service: "test",
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  method: HttpMethod.Get,
  path: "/api/read",
  access: AccessPolicy.Public,
  timeoutMs: 30000,
  mutation: false,
  input: emptyInput,
  output: z.strictObject({
    status: z.literal("ok"),
    services: z.record(z.string(), componentHealthSchema),
  }),
  status: HttpStatus.OK,
  description: "Structural registry fixture.",
} as const;
const operations = {
  read,
  write: {
    ...read,
    id: "test.write",
    method: HttpMethod.Post,
    path: "/api/write",
    access: AccessPolicy.Client,
    mutation: true,
  },
};
test("execution proof requires client access and registration", () => {
  const registry = new OperationRegistry();
  for (const invalid of [
    { ...read, requiresExecution: true },
    {
      ...read,
      access: AccessPolicy.Client,
      requiresExecution: true,
      requiresRegistration: false,
    },
  ])
    assert.throws(
      () =>
        registry.register(invalid, () => {
          throw new Error("unused");
        }),
      /execution proof requires/,
    );
  assert.doesNotThrow(() =>
    registry.register(
      { ...read, access: AccessPolicy.Client, requiresExecution: true },
      () => {
        throw new Error("unused");
      },
    ),
  );
});
test("registry rejects undeclared access policies, duplicates, versioned paths and late registration", () => {
  const registry = new OperationRegistry();
  assert.throws(
    () =>
      registry.register(
        {
          ...operations.read,
          access: undefined,
        } as unknown as Operation,
        () => ({}),
      ),
    /access policy/,
  );
  assert.throws(
    () =>
      registry.register(
        { ...operations.read, path: "/api/v1/healthcheck" },
        () => {
          throw new Error();
        },
      ),
    /unversioned/,
  );
  assert.throws(
    () =>
      registry.register({ ...operations.read, mutation: true }, () => {
        throw new Error();
      }),
    /verified caller/,
  );
  for (const lifetime of [undefined, "invalid"])
    assert.throws(
      () =>
        registry.register(
          { ...operations.read, lifetime } as unknown as Operation,
          () => ({}),
        ),
      /valid lifetime/,
    );
  registry.register(operations.read, () => ({
    status: "ok" as const,
    services: { gateway: { listener: 200 as const } },
  }));
  assert.throws(
    () =>
      registry.register(operations.read, () => {
        throw new Error();
      }),
    /Duplicate/,
  );
  assert.throws(() => registry.seal({}), /unavailable store: operational/);
  registry.seal({ [StoreName.Operational]: {} });
  assert.throws(
    () =>
      registry.register(operations.write, () => {
        throw new Error();
      }),
    /closed/,
  );
});
test("registry admits /hooks for a delivery operation alone", () => {
  const registry = new OperationRegistry();
  const delivery = {
    ...operations.write,
    id: "test.delivery",
    path: "/hooks/:inbound_id",
    access: AccessPolicy.Delivery,
    mutation: false,
    delivery: true,
  } as const;
  const unused = () => {
    throw new Error("unused");
  };
  assert.throws(
    () =>
      registry.register(
        {
          ...operations.write,
          path: "/hooks/human",
          access: AccessPolicy.Human,
        },
        unused,
      ),
    /unversioned \/api prefix/,
  );
  assert.throws(
    () => registry.register({ ...delivery, path: "/api/hooks/test" }, unused),
    /\/hooks prefix/,
  );
  assert.throws(
    () => registry.register({ ...delivery, mutation: true }, unused),
    /A delivery operation is no mutation/,
  );
  registry.register(delivery, unused);
  assert.deepEqual(
    registry.all().map(({ operation }) => operation.path),
    [delivery.path],
  );
});
