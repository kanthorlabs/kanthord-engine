import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ulid } from "ulid";
import { decode, sign } from "hono/jwt";
import { gatewayFixture } from "./test-support.ts";
import { deriveKey } from "../kernel/json.ts";
import {
  emptyInput,
  type Operation,
  OperationRegistry,
  StoreName,
} from "../kernel/operation.ts";
import { createInvocation } from "./index.ts";
import { generateHumanJWT } from "./auth/jwt.ts";
import { isHumanIdentity, isMachineIdentity } from "../kernel/caller.ts";
import { errorSchema } from "../kernel/errors.ts";
import { OperationError as GatewayError } from "../kernel/errors.ts";
import { directClient } from "./index.ts";
import { httpClient } from "./client.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { HttpStatus } from "../kernel/http.ts";
import { gatewayOperations } from "./contract.ts";
import { AccessPolicy, OperationLifetime } from "../kernel/operation.ts";
import { KANTHORD_AUTH_USERNAME } from "./auth/jwt.ts";
import {
  cancelled as aborted,
  CancellationContext,
} from "../kernel/context.ts";
import { HealthStatus } from "../kernel/service.ts";
import { compareRouteSpecificity } from "./service.ts";
import { GATEWAY_STARTED_MESSAGE } from "./constants.ts";
import { createIdempotencyKey } from "../kernel/identity.ts";
import { stopAfter } from "../kernel/test-support.ts";

const AUTH_VERSION = 1;
const NEXT_VERSION_STEP = 1;

const HUMAN_USERNAME = "ulrich";
const SINGLE_EXECUTION_COUNT = 1;
const KEEP_ALIVE_POLL_MS = 20;
const STOP_LIMIT_MS = 2000;
const STOP_TIMED_OUT = "stop timed out";
const CONNECTION_HEADER = "connection";
const KEEP_ALIVE = "keep-alive";
const HANDSHAKE_SEGMENT = "handshake";
const HANDSHAKE_HEADER = "x-test-kind";
const EMPTY_RESPONSE_BODY = "";
const DELIVERY_SIGNATURE = "exact";
const DELIVERY_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
const HOST_LIMIT = 255;
const INFO_LEVEL = 30;
const ERROR_LEVEL = 50;
const UNKNOWN_FAILURE = "gateway.invocation.unknown";
const FAILED_MESSAGE = "Request failed";
const HANDLER_BUG = "handler bug";
const LOOPBACK_BIND_SENTENCE =
  "A loopback bind accepts connections from this host only.";
const ExpectedErrorCode = {
  RouteNotFound: "gateway.routing.not_found",
  HostNotAllowed: "gateway.http.host_not_allowed",
  ValidationFailed: "gateway.request.validation_failed",
  Timeout: "gateway.invocation.timeout",
  BodyTooLarge: "gateway.request.body_too_large",
  Unauthorized: "gateway.authentication.unauthorized",
  Stopping: "gateway.invocation.stopping",
} as const;

const protectedRead = {
  id: "test.identity",
  service: "test",
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  method: "GET",
  path: "/api/identity",
  access: "human",
  timeoutMs: 30000,
  mutation: false,
  input: emptyInput,
  output: z.strictObject({ accountId: z.string() }),
  status: 200,
  description: "Read the verified test caller.",
} as const satisfies Operation;

test("a locally generated JWT authenticates the default human and forwards only minted identities without a password route", async (t) => {
  const registry = new OperationRegistry();
  let observed: unknown;
  registry.register(protectedRead, (_input, caller) => {
    observed = caller.identity;
    assert.equal(caller.request, undefined);
    if (!isHumanIdentity(caller.identity))
      throw new GatewayError(403, "test.identity.forbidden", "Human required.");
    return { accountId: caller.identity.accountId };
  });
  const fixture = await gatewayFixture(t, { registry });
  assert.equal(
    (await fixture.request("/api/identity")).status,
    HttpStatus.Unauthorized,
  );
  const removed = await fixture.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: KANTHORD_AUTH_USERNAME,
      marker: "removed-route",
    }),
  });
  assert.equal(removed.status, HttpStatus.NotFound);
  const token = fixture.token;
  const protectedResponse = await fixture.request("/api/identity", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(protectedResponse.status, HttpStatus.OK);
  assert.deepEqual(await protectedResponse.json(), {
    accountId: fixture.accountId,
  });
  assert.equal(isHumanIdentity(observed), true);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(
    isHumanIdentity({ kind: "human", accountId: fixture.accountId }),
    false,
  );
  assert.equal(
    isMachineIdentity({ kind: "client", clientId: "forged" }),
    false,
  );
  const forged = await fixture.gateway.invocation.invoke(
    protectedRead.id,
    { params: {}, query: {}, body: null },
    {
      identity: {
        kind: "human",
        accountId: fixture.accountId,
        name: fixture.accountId,
        jti: ulid(),
      },
    },
  );
  assert.equal(forged.status, HttpStatus.Unauthorized);
  assert.doesNotMatch(fixture.logs.join(""), /secret-marker/);
  assert.ok(!fixture.logs.join("").includes(token));
});

test("JWT verification rejects expiry, wrong algorithm, invalid usernames, account claims and other master keys", async (t) => {
  const registry = new OperationRegistry();
  registry.register(protectedRead, (_input, caller) => ({
    accountId: isHumanIdentity(caller.identity)
      ? caller.identity.accountId
      : "",
  }));
  const fixture = await gatewayFixture(t, { registry });
  const token = fixture.token;
  const claims = decode(token).payload;
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(
      deriveKey(fixture.config.master_key, "gateway/jwt-hs256/v1"),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const expired = await sign(
    { ...claims, exp: Math.floor(Date.now() / 1000) - 1 },
    key,
    "HS256",
  );
  for (const invalid of [expired, "invalid", token.slice(0, -3) + "AAA"]) {
    assert.equal(
      (
        await fixture.request("/api/identity", {
          headers: { Authorization: `Bearer ${invalid}` },
        })
      ).status,
      HttpStatus.Unauthorized,
    );
  }
  const otherAlgorithm = await sign(claims, "another-key", "HS512");
  assert.equal(
    (
      await fixture.request("/api/identity", {
        headers: { Authorization: `Bearer ${otherAlgorithm}` },
      })
    ).status,
    HttpStatus.Unauthorized,
  );
  for (const changes of [
    { sub: "" },
    { sub: " " },
    { sub: "u".repeat(65) },
    { binding: "machine" },
  ]) {
    const invalid = await sign(
      { ...claims, jti: ulid(), ...changes },
      key,
      "HS256",
    );
    assert.equal(
      (
        await fixture.request("/api/identity", {
          headers: { Authorization: `Bearer ${invalid}` },
        })
      ).status,
      HttpStatus.Unauthorized,
    );
  }
  const otherMasterKey = Buffer.alloc(32, 1).toString("base64");
  const foreign = await generateHumanJWT(otherMasterKey, AUTH_VERSION, 600);
  assert.equal(
    (
      await fixture.request("/api/identity", {
        headers: { Authorization: `Bearer ${foreign.token}` },
      })
    ).status,
    HttpStatus.Unauthorized,
  );
  const fresh = await generateHumanJWT(
    fixture.config.master_key,
    fixture.config.gateway.auth.version,
    fixture.config.gateway.auth.token_lifetime,
  );
  assert.equal(
    (
      await fixture.request("/api/identity", {
        headers: { Authorization: `Bearer ${fresh.token}` },
      })
    ).status,
    HttpStatus.OK,
  );
  const rotated = createInvocation({
    registry: fixture.gateway.registry,
    stores: { [StoreName.Operational]: fixture.store },
    masterKey: otherMasterKey,
    authVersion: AUTH_VERSION,
  });
  stopAfter(t, () => rotated.stop());
  await assert.rejects(
    rotated.authentication.authenticate(`Bearer ${fresh.token}`),
    /Authentication required/,
  );
  const versioned = createInvocation({
    registry: fixture.gateway.registry,
    stores: { [StoreName.Operational]: fixture.store },
    masterKey: fixture.config.master_key,
    authVersion: fixture.config.gateway.auth.version + NEXT_VERSION_STEP,
  });
  stopAfter(t, () => versioned.stop());
  await assert.rejects(
    versioned.authentication.authenticate(`Bearer ${fresh.token}`),
    /Authentication required/,
  );
});

test("a JWT issued for an explicit username authenticates that human over HTTP and direct clients, and reissuance preserves the username", async (t) => {
  const registry = new OperationRegistry();
  registry.register(protectedRead, (_input, caller) => {
    assert.ok(isHumanIdentity(caller.identity));
    return { accountId: caller.identity.accountId };
  });
  const fixture = await gatewayFixture(t, { registry });
  const { token } = await generateHumanJWT(
    fixture.config.master_key,
    fixture.config.gateway.auth.version,
    600,
    "ulrich",
  );
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${token}`,
  );
  assert.deepEqual(identity, {
    kind: "human",
    accountId: HUMAN_USERNAME,
    name: HUMAN_USERNAME,
    jti: decode(token).payload.jti,
  });
  for (const client of [
    httpClient({ identity: protectedRead }, fixture.endpoint, token),
    directClient({ identity: protectedRead }, fixture.gateway.invocation),
  ]) {
    const result = await client.identity(
      { params: {}, query: {}, body: null },
      { identity },
    );
    assert.equal(result.type, OperationResultType.Completed);
    if (result.type === OperationResultType.Completed)
      assert.deepEqual(result.data, { accountId: "ulrich" });
  }
  const reissued = await generateHumanJWT(
    fixture.config.master_key,
    fixture.config.gateway.auth.version,
    600,
    "ulrich",
  );
  assert.notEqual(reissued.token, token);
  assert.equal(decode(reissued.token).payload.sub, HUMAN_USERNAME);
  assert.deepEqual(
    await fixture.gateway.authentication.authenticate(
      `Bearer ${reissued.token}`,
    ),
    { ...identity, jti: decode(reissued.token).payload.jti },
  );
  await assert.rejects(
    generateHumanJWT(
      fixture.config.master_key,
      fixture.config.gateway.auth.version,
      600,
      "",
    ),
    /username:/,
  );
});

test("direct and HTTP adapters share transactional idempotency, validation, failures and trace context", async (t) => {
  const registry = new OperationRegistry();
  const mutation = {
    ...protectedRead,
    id: "test.write",
    method: "POST",
    path: "/api/counter",
    mutation: true,
    body: true,
    input: emptyInput.extend({
      body: z.strictObject({ value: z.int().default(1) }),
    }),
    output: z.strictObject({ count: z.int() }),
  } as const;
  let calls = 0;
  let trace: string | undefined;
  registry.register(mutation, (input, caller) =>
    caller.commit(({ database }) => {
      calls++;
      trace = caller.traceparent;
      database.exec(
        "CREATE TABLE IF NOT EXISTS test_counter(value INTEGER NOT NULL)",
      );
      database
        .prepare("INSERT INTO test_counter VALUES (?)")
        .run(input.body.value);
      return {
        count: Number(
          database.prepare("SELECT SUM(value) AS count FROM test_counter").get()
            ?.count,
        ),
      };
    }),
  );
  const fixture = await gatewayFixture(t, { registry });
  const token = fixture.token;
  const caller = await fixture.gateway.authentication.authenticate(
    `Bearer ${token}`,
  );
  const http = httpClient({ mutation }, fixture.endpoint, token);
  const direct = directClient({ mutation }, fixture.gateway.invocation);
  const options = {
    identity: caller,
    idempotencyKey: createIdempotencyKey(),
    traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
  };
  const result = await http.mutation(
    { params: {}, query: {}, body: {} },
    options,
  );
  assert.equal(result.type, OperationResultType.Completed);
  const replay = await direct.mutation(
    { params: {}, query: {}, body: { value: 1 } },
    options,
  );
  assert.deepEqual(replay, result);
  assert.equal(calls, SINGLE_EXECUTION_COUNT);
  assert.equal(trace, options.traceparent);
  assert.equal(
    (
      await http.mutation(
        { params: {}, query: {}, body: { value: 2 } },
        options,
      )
    ).type,
    OperationResultType.Failure,
  );
  const badHTTP = await http.mutation({
    params: {},
    query: {},
    body: { value: "wrong" as unknown as number },
  });
  const badDirect = await direct.mutation(
    {
      params: {},
      query: {},
      body: { value: "wrong" as unknown as number },
    },
    { identity: caller },
  );
  assert.equal(badHTTP.type, OperationResultType.Failure);
  assert.equal(badDirect.type, OperationResultType.Failure);
  if (
    badHTTP.type === OperationResultType.Failure &&
    badDirect.type === OperationResultType.Failure
  ) {
    assert.deepEqual(badHTTP.error.error, badDirect.error.error);
    assert.equal(badHTTP.error.error.code, ExpectedErrorCode.ValidationFailed);
    assert.match(
      badHTTP.error.request_id,
      /^request_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
    );
    assert.match(
      badDirect.error.request_id,
      /^request_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
    );
  }
  const lost = await httpClient(
    { mutation },
    fixture.endpoint,
    token,
    async () => {
      throw new Error("answer lost");
    },
  ).mutation({ params: {}, query: {}, body: {} }, options);
  assert.deepEqual(lost, {
    type: OperationResultType.Indeterminate,
    idempotencyKey: options.idempotencyKey,
  });
});

test("expired replay executes the handler again while an unexpired replay does not", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const registry = new OperationRegistry();
  const operation = {
    ...protectedRead,
    mutation: true,
    method: "POST" as const,
  };
  let calls = 0;
  registry.register(operation, (_input, caller) =>
    caller.commit(() => ({ accountId: String(++calls) })),
  );
  const fixture = await gatewayFixture(t, { registry });
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.token}`,
  );
  const client = directClient({ operation }, fixture.gateway.invocation);
  const options = { identity, idempotencyKey: createIdempotencyKey() };
  const input = { params: {}, query: {}, body: null };
  const first = await client.operation(input, options);
  assert.deepEqual(await client.operation(input, options), first);
  assert.equal(calls, SINGLE_EXECUTION_COUNT);
  now += fixture.config.gateway.idempotency_ttl * 1000;
  assert.notDeepEqual(await client.operation(input, options), first);
  assert.equal(calls, SINGLE_EXECUTION_COUNT + SINGLE_EXECUTION_COUNT);
});

test("timeout leaves a mutation in progress until its atomic commit, then replays without repeating", async (t) => {
  const registry = new OperationRegistry();
  const gate = Promise.withResolvers<void>();
  const mutation = {
    ...protectedRead,
    id: "test.slow",
    method: "POST",
    path: "/api/slow",
    mutation: true,
    timeoutMs: 50,
    output: z.strictObject({ done: z.boolean() }),
  } as const;
  let count = 0;
  registry.register(mutation, async (_input, caller) => {
    await gate.promise;
    return caller.commit(() => {
      count++;
      return { done: true };
    });
  });
  const fixture = await gatewayFixture(t, { registry });
  const token = fixture.token;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": createIdempotencyKey(),
  };
  const timeout = await fixture.request("/api/slow", {
    method: "POST",
    headers,
  });
  assert.equal(timeout.status, HttpStatus.GatewayTimeout);
  assert.equal(
    errorSchema.parse(await timeout.json()).error.code,
    ExpectedErrorCode.Timeout,
  );
  assert.equal(
    (await fixture.request("/api/slow", { method: "POST", headers })).status,
    HttpStatus.Conflict,
  );
  gate.resolve();
  await fixture.gateway.invocation.drain();
  const replay = await fixture.request("/api/slow", {
    method: "POST",
    headers,
  });
  assert.equal(replay.status, HttpStatus.OK);
  assert.deepEqual(await replay.json(), { done: true });
  assert.equal(count, SINGLE_EXECUTION_COUNT);
});

test("a delivery under /hooks forwards exact bytes and headers, refuses a body above 50 MiB, and the shutdown context closes an active stream", async (t) => {
  const registry = new OperationRegistry();
  const bytes = Buffer.from('{ "b" : 1,\r\n"a":2.0 }\n');
  let delivered = 0;
  registry.register(
    {
      ...protectedRead,
      id: "test.delivery",
      method: "POST",
      path: "/hooks/:inbound_id",
      access: AccessPolicy.Delivery,
      delivery: true,
      output: z.strictObject({ accepted: z.boolean() }),
    },
    (_input, caller) => {
      delivered += 1;
      assert.equal(caller.identity, undefined);
      assert.deepEqual(Buffer.from(caller.delivery!.bytes), bytes);
      assert.equal(
        caller.delivery!.headers.get("x-signature"),
        DELIVERY_SIGNATURE,
      );
      return { accepted: true };
    },
  );
  let cancelled = false;
  registry.register(
    {
      ...protectedRead,
      id: "test.stream",
      path: "/api/mcp/test",
      lifetime: OperationLifetime.Stream,
      timeoutMs: 900000,
      output: z.string(),
      contentType: "text/event-stream",
    },
    (_input, caller) => {
      assert.equal(caller.request?.headers.get("authorization"), null);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
            addAbortListener(caller.context.signal, () => {
              cancelled = true;
              controller.close();
            });
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  const fixture = await gatewayFixture(t, { registry });
  const delivery = await fixture.request("/hooks/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": "exact",
    },
    body: bytes,
  });
  assert.equal(delivery.status, HttpStatus.OK);
  assert.equal(delivered, SINGLE_EXECUTION_COUNT);
  const oversized = await fixture.request("/hooks/test", {
    method: "POST",
    headers: { "x-signature": DELIVERY_SIGNATURE, connection: "keep-alive" },
    body: Buffer.alloc(DELIVERY_BODY_LIMIT_BYTES + 1),
  });
  assert.equal(oversized.status, HttpStatus.PayloadTooLarge);
  assert.equal(
    errorSchema.parse(await oversized.json()).error.code,
    ExpectedErrorCode.BodyTooLarge,
  );
  assert.equal(delivered, SINGLE_EXECUTION_COUNT);
  const token = fixture.token;
  const stream = await fixture.request("/api/mcp/test", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const reader = stream.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(await fixture.gateway.stop(), null);
  assert.equal(cancelled, true);
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(await fixture.gateway.healthcheck(), {
    listener: 503,
    authentication: 503,
    idempotency: 503,
    registry: 503,
    invocation: 503,
  });
});

test("a delivery answers the Response of its handler, after a commit or without one", async (t) => {
  const registry = new OperationRegistry();
  let committed = 0;
  registry.register(
    {
      ...protectedRead,
      id: "test.delivery.response",
      method: "POST",
      path: "/hooks/:inbound_id",
      access: AccessPolicy.Delivery,
      delivery: true,
      status: HttpStatus.Accepted,
      output: z.null(),
    },
    (_input, caller) => {
      assert.ok(caller.delivery);
      if (caller.delivery.headers.get(HANDSHAKE_HEADER) === HANDSHAKE_SEGMENT)
        return new Response(null, { status: HttpStatus.NoContent });
      caller.commit(() => {
        committed += 1;
        return null;
      });
      return new Response(null, { status: HttpStatus.Accepted });
    },
  );
  const fixture = await gatewayFixture(t, { registry });
  for (const [name, status] of [
    ["event", HttpStatus.Accepted],
    [HANDSHAKE_SEGMENT, HttpStatus.NoContent],
  ] as const) {
    const answer = await fixture.request("/hooks/test", {
      method: "POST",
      headers: { [HANDSHAKE_HEADER]: name },
      body: "{}",
    });
    assert.equal(answer.status, status);
    assert.equal(await answer.text(), EMPTY_RESPONSE_BODY);
  }
  assert.equal(committed, SINGLE_EXECUTION_COUNT);
});

test("client disconnect reaches waiting handlers", async (t) => {
  const registry = new OperationRegistry();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  registry.register(
    { ...protectedRead, id: "test.wait", path: "/api/wait" },
    async (_input, caller) => {
      entered.resolve();
      await aborted(caller.context.signal);
      cancelled.resolve();
      return { accountId: "cancelled" };
    },
  );
  const fixture = await gatewayFixture(t, { registry });
  const token = fixture.token;
  const abort = new AbortController();
  const request = fixture
    .request("/api/wait", {
      signal: abort.signal,
      headers: { Authorization: `Bearer ${token}` },
    })
    .catch(() => {});
  await entered.promise;
  abort.abort();
  await cancelled.promise;
  await request;
});

test("the verification API returns only JWT-named business properties and requires a bearer token", async (t) => {
  const fixture = await gatewayFixture(t);
  const client = httpClient(gatewayOperations, fixture.endpoint, fixture.token);
  const result = await client.verify({ params: {}, query: {}, body: null });
  assert.equal(result.type, OperationResultType.Completed);
  if (result.type === OperationResultType.Completed)
    assert.deepEqual(result.data, {
      kind: "human",
      sub: KANTHORD_AUTH_USERNAME,
      name: KANTHORD_AUTH_USERNAME,
    });
  for (const headers of [{}, { Authorization: "Bearer invalid" }]) {
    const response = await fixture.request("/api/auth/verify", { headers });
    assert.equal(response.status, HttpStatus.Unauthorized);
    assert.equal(
      errorSchema.parse(await response.json()).error.code,
      ExpectedErrorCode.Unauthorized,
    );
  }
  assert.equal(fixture.gateway.invocation.idempotency.healthcheck(), true);
});

test("component health reports stopped in-memory idempotency with integer codes", async (t) => {
  const fixture = await gatewayFixture(t);
  fixture.gateway.invocation.idempotency.stop();
  const components = await fixture.gateway.healthcheck();
  assert.equal(components.idempotency, HealthStatus.Unavailable);
  assert.equal(components.listener, HealthStatus.Healthy);
  assert.equal(components.authentication, HealthStatus.Healthy);
  assert.ok(Object.values(components).every(Number.isInteger));
  const response = await fixture.request("/api/liveness");
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  const body = errorSchema.parse(await response.json());
  assert.deepEqual(body.error.details, { gateway: components });
  assert.match(body.request_id, /^request_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
});

test("quiescence cancels HTTP work, preserves direct calls during drain and releases only after drain", async (t) => {
  const registry = new OperationRegistry();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let executions = 0;
  const operation = {
    ...protectedRead,
    id: "test.drain",
    path: "/api/drain",
  } as const;
  registry.register(operation, async (_input, caller) => {
    executions++;
    entered.resolve();
    await aborted(caller.context.signal);
    cancelled.resolve();
    await release.promise;
    assert.equal(fixture.store.healthcheck(), true);
    return { accountId: "finished" };
  });
  registry.register(protectedRead, () => ({ accountId: "available" }));
  const fixture = await gatewayFixture(t, { registry });
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.token}`,
  );
  const client = directClient(
    { read: protectedRead },
    fixture.gateway.invocation,
  );
  const input = { params: {}, query: {}, body: null };
  const request = fixture.request(operation.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  await entered.promise;
  const quiescing = fixture.gateway.quiesce();
  assert.equal(quiescing, fixture.gateway.quiesce());
  assert.equal(await quiescing, null);
  await cancelled.promise;
  let drained = false;
  const drain = fixture.gateway.drain().then(() => {
    drained = true;
  });
  assert.equal(
    (await client.read(input, { identity })).type,
    OperationResultType.Completed,
  );
  assert.equal(drained, false);
  release.resolve();
  assert.deepEqual(await (await request).json(), { accountId: "finished" });
  await drain;
  assert.equal(await fixture.gateway.invocation.stop(), null);
  const stopping = fixture.gateway.stop();
  assert.equal(stopping, fixture.gateway.stop());
  assert.equal(await stopping, null);
  assert.equal(fixture.gateway.address(), undefined);
  const result = await client.read(input, { identity });
  assert.equal(result.type, OperationResultType.Failure);
  if (result.type === OperationResultType.Failure)
    assert.equal(result.error.error.code, ExpectedErrorCode.Stopping);
  assert.equal(executions, SINGLE_EXECUTION_COUNT);
  assert.ok((await fixture.gateway.start()) instanceof Error);
});

test("a keep-alive client that keeps its connection busy across quiescence does not hold the stop", async (t) => {
  const registry = new OperationRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const operation = {
    ...protectedRead,
    id: "test.held",
    path: "/api/held",
  } as const;
  registry.register(operation, async () => {
    entered.resolve();
    await release.promise;
    return { accountId: "held" };
  });
  registry.register(protectedRead, () => ({ accountId: "available" }));
  const fixture = await gatewayFixture(t, { registry });
  const headers = { Authorization: `Bearer ${fixture.token}` };
  const held = fetch(fixture.endpoint + operation.path, { headers });
  await entered.promise;
  assert.equal(await fixture.gateway.quiesce(), null);
  release.resolve();
  assert.deepEqual(await (await held).json(), { accountId: "held" });
  let polling = true;
  const poll = (async () => {
    while (polling) {
      await fetch(fixture.endpoint + protectedRead.path, { headers })
        .then((response) => response.arrayBuffer())
        .catch(() => null);
      await delay(KEEP_ALIVE_POLL_MS);
    }
  })();
  try {
    assert.equal(
      await Promise.race([
        fixture.gateway.stop(),
        delay(STOP_LIMIT_MS, STOP_TIMED_OUT, { ref: false }),
      ]),
      null,
    );
  } finally {
    polling = false;
    await poll;
  }
});

test("a keep-alive response that leaves after quiescence does not hold the stop", async (t) => {
  const registry = new OperationRegistry();
  registry.register(protectedRead, () => ({ accountId: "late" }));
  const fixture = await gatewayFixture(t, { registry });
  const listener = fixture.gateway["listener"] as Server;
  listener.prependListener("request", (_request, response) => {
    const writeHead = response.writeHead.bind(response);
    response.writeHead = ((...args: Parameters<typeof writeHead>) => {
      void fixture.gateway.quiesce();
      return writeHead(...args);
    }) as typeof writeHead;
  });
  const answer = await fetch(fixture.endpoint + protectedRead.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(answer.headers.get(CONNECTION_HEADER), KEEP_ALIVE);
  assert.deepEqual(await answer.json(), { accountId: "late" });
  assert.equal(
    await Promise.race([
      fixture.gateway.stop(),
      delay(STOP_LIMIT_MS, STOP_TIMED_OUT, { ref: false }),
    ]),
    null,
  );
});

test("direct and HTTP client cancellation uses Context", async (t) => {
  const registry = new OperationRegistry();
  let entered = Promise.withResolvers<void>();
  let cancelled = Promise.withResolvers<void>();
  const operation = {
    ...protectedRead,
    id: "test.cancel",
    path: "/api/cancel",
  } as const;
  registry.register(operation, async (_input, caller) => {
    entered.resolve();
    await aborted(caller.context.signal);
    cancelled.resolve();
    return { accountId: "cancelled" };
  });
  const fixture = await gatewayFixture(t, { registry });
  const token = fixture.token;
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${token}`,
  );
  for (const client of [
    directClient({ cancel: operation }, fixture.gateway.invocation),
    httpClient({ cancel: operation }, fixture.endpoint, token),
  ]) {
    entered = Promise.withResolvers<void>();
    cancelled = Promise.withResolvers<void>();
    const context = new CancellationContext();
    const request = client.cancel(
      { params: {}, query: {}, body: null },
      { context, identity },
    );
    await entered.promise;
    context.cancel();
    await cancelled.promise;
    await request;
  }
});

test("HTTP authentication precedes body framing and schema validation", async (t) => {
  const registry = new OperationRegistry();
  const create = {
    ...protectedRead,
    id: "test.create",
    method: "POST",
    path: "/api/named",
    body: true,
    input: emptyInput.extend({ body: z.strictObject({ name: z.string() }) }),
  } as const;
  const touch = {
    ...protectedRead,
    id: "test.touch",
    method: "POST",
    path: "/api/touch",
  } as const;
  registry.register(create, () => ({ accountId: HUMAN_USERNAME }));
  registry.register(touch, () => ({ accountId: HUMAN_USERNAME }));
  const fixture = await gatewayFixture(t, { registry });
  const json = "application/json";
  const attempts = [
    { path: create.path, type: json, body: "{}" },
    { path: create.path, type: json, body: "{" },
    { path: create.path, type: "text/plain", body: "{}" },
    { path: touch.path, type: json, body: "{}" },
  ];
  const refusals = [
    ExpectedErrorCode.ValidationFailed,
    "gateway.request.invalid_json",
    "gateway.request.unsupported_media_type",
    "gateway.request.unexpected_body",
  ];
  const send = (attempt: (typeof attempts)[number], authorization?: string) =>
    fixture.request(attempt.path, {
      method: "POST",
      headers: {
        "Content-Type": attempt.type,
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: attempt.body,
    });
  for (const authorization of [undefined, "Bearer garbage"])
    for (const attempt of attempts) {
      const response = await send(attempt, authorization);
      assert.equal(response.status, HttpStatus.Unauthorized);
      assert.equal(
        errorSchema.parse(await response.json()).error.code,
        ExpectedErrorCode.Unauthorized,
      );
    }
  for (const [index, attempt] of attempts.entries()) {
    const response = await send(attempt, `Bearer ${fixture.token}`);
    assert.equal(
      errorSchema.parse(await response.json()).error.code,
      refusals[index],
    );
  }
});

test("HTTP validation failure names each unrecognized key of the body", async (t) => {
  const registry = new OperationRegistry();
  const create = {
    ...protectedRead,
    id: "test.create",
    method: "POST",
    path: "/api/named",
    body: true,
    input: emptyInput.extend({ body: z.strictObject({ name: z.string() }) }),
  } as const;
  registry.register(create, () => ({ accountId: HUMAN_USERNAME }));
  const fixture = await gatewayFixture(t, { registry });
  const response = await fixture.request(create.path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${fixture.token}`,
    },
    body: JSON.stringify({ name: "a", first: 1, second: 2 }),
  });
  assert.equal(response.status, HttpStatus.BadRequest);
  const { error } = errorSchema.parse(await response.json());
  assert.equal(error.code, ExpectedErrorCode.ValidationFailed);
  assert.deepEqual(error.details, [
    { path: ["body", "first"], code: "unrecognized_keys" },
    { path: ["body", "second"], code: "unrecognized_keys" },
  ]);
});

test("the host refusal names the refused host and the allowlist field, never the allowlist", async (t) => {
  const fixture = await gatewayFixture(t);
  const refusals: [Record<string, string>, string | null][] = [
    [{ Host: "Foo.Example:1" }, "foo.example:1"],
    [{ Host: "a".repeat(HOST_LIMIT + 1) }, "a".repeat(HOST_LIMIT)],
    [{}, null],
  ];
  for (const [headers, host] of refusals) {
    const response = await fixture.gateway.app.request("/api/healthcheck", {
      headers,
    });
    assert.equal(response.status, HttpStatus.Forbidden);
    const body = errorSchema.parse(await response.json());
    assert.deepEqual(body.error, {
      code: ExpectedErrorCode.HostNotAllowed,
      message: "Host is not allowed. Add it to gateway.allowed_hosts.",
      details: { host, field: "gateway.allowed_hosts" },
    });
    assert.doesNotMatch(JSON.stringify(body), /localhost|127\.0\.0\.1/);
  }
});

test("the start record states the bind and the port, and a loopback bind states its reach", async (t) => {
  for (const [bind, message] of [
    ["127.0.0.1", `${GATEWAY_STARTED_MESSAGE}. ${LOOPBACK_BIND_SENTENCE}`],
    ["::1", `${GATEWAY_STARTED_MESSAGE}. ${LOOPBACK_BIND_SENTENCE}`],
    [
      "::ffff:127.0.0.1",
      `${GATEWAY_STARTED_MESSAGE}. ${LOOPBACK_BIND_SENTENCE}`,
    ],
    ["::", GATEWAY_STARTED_MESSAGE],
  ] as const) {
    const fixture = await gatewayFixture(t, { bind });
    const records = fixture.logs
      .map((line) => JSON.parse(line))
      .filter((record) => record.msg.startsWith(GATEWAY_STARTED_MESSAGE));
    assert.equal(records.length, SINGLE_EXECUTION_COUNT);
    assert.equal(records[0].level, INFO_LEVEL);
    assert.equal(records[0].msg, message);
    assert.equal(records[0].bind, bind);
    assert.equal(records[0].port, fixture.gateway.address()!.port);
    assert.equal(records[0].address, undefined);
  }
});

test("a static path segment registers before a parameter segment at the same position", () => {
  const paths = [
    "/api/agent/:agentName",
    "/api/agent/prompt",
    "/api/agent/model",
    "/api/agent/enablement/:agentName",
  ];
  assert.deepEqual([...paths].sort(compareRouteSpecificity), [
    "/api/agent/prompt",
    "/api/agent/model",
    "/api/agent/enablement/:agentName",
    "/api/agent/:agentName",
  ]);
});

test("an HTTP request that fails with an unknown error answers 500 and logs the error at the error level", async (t) => {
  const registry = new OperationRegistry();
  registry.register(protectedRead, () => {
    throw new Error(HANDLER_BUG);
  });
  const fixture = await gatewayFixture(t, { registry });
  const response = await fixture.request(protectedRead.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.InternalServerError);
  const { error, request_id: requestId } = errorSchema.parse(
    await response.json(),
  );
  assert.equal(error.code, UNKNOWN_FAILURE);
  const failed = fixture.logs
    .map((line) => JSON.parse(line))
    .filter((record) => record.msg === FAILED_MESSAGE);
  assert.equal(failed.length, SINGLE_EXECUTION_COUNT);
  assert.equal(failed[0].level, ERROR_LEVEL);
  assert.equal(failed[0].request_id, requestId);
  assert.equal(failed[0].operation, protectedRead.id);
  assert.equal(failed[0].err.message, HANDLER_BUG);
  assert.doesNotMatch(JSON.stringify(failed[0]), new RegExp(fixture.token));
});
