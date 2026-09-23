import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  AccessPolicy,
  emptyInput,
  OperationRegistry,
  type Operation,
} from "./operation.ts";
import { componentHealthSchema } from "./health.ts";
import { HttpMethod, HttpStatus } from "./http.ts";
const read = {
  id: "test.read",
  service: "test",
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
  registry.seal();
  assert.throws(
    () =>
      registry.register(operations.write, () => {
        throw new Error();
      }),
    /closed/,
  );
});
