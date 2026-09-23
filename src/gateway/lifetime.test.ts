import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  AccessPolicy,
  emptyInput,
  OperationLifetime,
  OperationRegistry,
  OperationResultType,
  StoreName,
} from "../kernel/operation.ts";
import { CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { directClient } from "./direct-client.ts";
import { httpClient } from "./client.ts";
import { gatewayFixture } from "./test-support.ts";

const base = {
  id: "test.lifetime",
  service: "test",
  path: "/api/test/lifetime",
  method: HttpMethod.Get,
  access: AccessPolicy.Public,
  store: StoreName.Operational,
  timeoutMs: 30000,
  mutation: false,
  status: HttpStatus.OK,
  input: emptyInput,
  output: z.string(),
  description: "Lifetime fixture.",
} as const;
const input = { params: {}, query: {}, body: null };
const READY_EVENT = "data: ready\n\n";
const CANCELLED_CODE = "gateway.invocation.cancelled";
const ACCEPTED_OBLIGATION = 1;

test("stream clients return an open body through direct and HTTP adapters and join on cancellation", async (t) => {
  const registry = new OperationRegistry();
  const operation = {
    ...base,
    lifetime: OperationLifetime.Stream,
    contentType: "text/event-stream",
  };
  let cancelled = 0;
  registry.register(
    operation,
    (_input, caller) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
            caller.context.onCancel(() => {
              cancelled++;
            });
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const fixture = await gatewayFixture(t, { registry });
  const directContext = new CancellationContext();
  const direct = await directClient(
    { operation },
    fixture.gateway.invocation,
  ).operation(input, { context: directContext });
  const http = await httpClient({ operation }, fixture.endpoint).operation(
    input,
  );
  assert.ok(direct.type === OperationResultType.Completed);
  assert.ok(http.type === OperationResultType.Completed);
  const readers = [direct.data.body!.getReader(), http.data.body!.getReader()];
  for (const reader of readers)
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      READY_EVENT,
    );
  let joined = false;
  const drain = fixture.gateway.invocation.stop().then((error) => {
    assert.equal(error, null);
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  directContext.cancel();
  assert.equal(await fixture.gateway.quiesce(), null);
  for (const reader of readers) assert.equal((await reader.read()).done, true);
  await drain;
  assert.equal(cancelled, readers.length);
});

test("wait cancellation ends the answer without undoing an already committed effect", async (t) => {
  const registry = new OperationRegistry();
  const operation = {
    ...base,
    lifetime: OperationLifetime.Wait,
    method: HttpMethod.Post,
    access: AccessPolicy.Human,
    mutation: true,
  };
  const entered = Promise.withResolvers<void>();
  registry.register(operation, async (_input, caller) => {
    caller.commit(({ database }) => {
      database.exec(
        "CREATE TABLE test_obligation (accepted INTEGER); INSERT INTO test_obligation VALUES (1)",
      );
      return "accepted";
    });
    entered.resolve();
    await caller.context.done();
    throw new OperationError(
      HttpStatus.ServiceUnavailable,
      "gateway.invocation.cancelled",
      "Request cancelled.",
    );
  });
  const fixture = await gatewayFixture(t, { registry });
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.token}`,
  );
  const context = new CancellationContext();
  const request = directClient(
    { operation },
    fixture.gateway.invocation,
  ).operation(input, { identity, context });
  await entered.promise;
  context.cancel();
  const result = await request;
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, HttpStatus.ServiceUnavailable);
  assert.equal(result.error.error.code, CANCELLED_CODE);
  assert.equal(
    fixture.store.database.prepare("SELECT accepted FROM test_obligation").get()
      ?.accepted,
    ACCEPTED_OBLIGATION,
  );
});
