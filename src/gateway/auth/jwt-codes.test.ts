import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { decode, sign } from "hono/jwt";
import { ulid } from "ulid";
import { deriveKey } from "../../kernel/json.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { OperationError } from "../../kernel/errors.ts";
import { isMachineIdentity, isWorkerIdentity } from "../../kernel/caller.ts";
import { WorkerPlacement } from "../../project/contract.ts";
import type { LiveInstance } from "../../worker/contract.ts";
import {
  authenticationFixture,
  fakeLookups,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "../test-support.ts";
import { generateInstanceClientJWT, generateWorkerJWT } from "./jwt.ts";
import { JwtCause } from "../errors.ts";

const SERVER_BINDING = "server-binding";
const INSTANCE_NAME = "laptop";
const OTHER_INSTANCE_NAME = "desktop";
const SECONDS_PER_HOUR = 3600;
const MILLISECONDS_PER_SECOND = 1000;
const WORKER_RESOURCE = `worker:kanthord:${TEST_WORKER_BINDING}`;
const SERVER_RESOURCE = `worker:kanthord:${SERVER_BINDING}`;
const UNAUTHORIZED_CODE = "gateway.authentication.unauthorized";
const DRAINED_BINDING = "drained-binding";
const DRAINED_RESOURCE = `worker:kanthord:${DRAINED_BINDING}`;

function instanceLookups() {
  const base = fakeLookups();
  const live = new Map<string, LiveInstance>();
  const connections = new Map<string, string>();
  const listed: string[] = [INSTANCE_NAME];
  const lookups = {
    ...base,
    project: {
      async resolveWorkerGroup(projectId: string, resourceIdentity: string) {
        if (projectId !== TEST_PROJECT_ID) return null;
        if (resourceIdentity === WORKER_RESOURCE)
          return {
            project_id: projectId,
            resource_identity: resourceIdentity,
            placement: WorkerPlacement.Worker,
            worker_instances: listed,
          };
        if (resourceIdentity === DRAINED_RESOURCE)
          return {
            project_id: projectId,
            resource_identity: resourceIdentity,
            placement: null,
            worker_instances: [],
          };
        if (resourceIdentity === SERVER_RESOURCE)
          return {
            project_id: projectId,
            resource_identity: resourceIdentity,
            placement: WorkerPlacement.Server,
          };
        return null;
      },
      async workerGroupEnded() {
        return false;
      },
    },
    instances: {
      liveInstance: (instanceId: string) => live.get(instanceId) ?? null,
      holdConnection(instanceId: string, connectionId: string) {
        const current = connections.get(instanceId);
        if (current === undefined) connections.set(instanceId, connectionId);
        return current === undefined || current === connectionId;
      },
    },
  };
  return { lookups, live, connections, listed };
}

async function fixtureOf(t: TestContext) {
  const state = instanceLookups();
  const fixture = await authenticationFixture(t, state.lookups);
  const instanceId = `worker_instance_${ulid()}`;
  const connectionId = `connection_${ulid()}`;
  state.live.set(instanceId, {
    id: instanceId,
    name: INSTANCE_NAME,
    worker: "coder@1",
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(
      deriveKey(fixture.config.master_key, "gateway/jwt-hs256/v1"),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const workerToken = (
    await generateWorkerJWT(
      fixture.config.master_key,
      fixture.config.gateway.auth.version,
      { instanceId, name: INSTANCE_NAME },
    )
  ).token;
  const clientToken = async (
    overrides: {
      resourceIdentity?: string;
      connectionId?: string;
      clientId?: string;
    } = {},
  ) =>
    (
      await generateInstanceClientJWT(
        fixture.config.master_key,
        fixture.config.gateway.auth.version,
        {
          clientId: overrides.clientId ?? `client_identity_${ulid()}`,
          projectId: TEST_PROJECT_ID,
          resourceIdentity: overrides.resourceIdentity ?? WORKER_RESOURCE,
          instanceId,
          connectionId: overrides.connectionId ?? connectionId,
          name: INSTANCE_NAME,
        },
      )
    ).token;
  const signed = (claims: Record<string, unknown>) =>
    sign(claims, key, "HS256");
  const refuse = (token: string, cause: JwtCause) =>
    assert.rejects(
      fixture.authentication.authenticate(`Bearer ${token}`),
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Unauthorized &&
        error.code === `gateway.jwt.${cause}`,
    );
  return {
    ...state,
    fixture,
    instanceId,
    connectionId,
    workerToken,
    clientToken,
    signed,
    refuse,
  };
}

test("a worker token and an instance client token authenticate", async (t) => {
  const subject = await fixtureOf(t);
  const worker = await subject.fixture.authentication.authenticate(
    `Bearer ${subject.workerToken}`,
  );
  assert.ok(isWorkerIdentity(worker));
  assert.equal(worker.instanceId, subject.instanceId);
  const client = await subject.fixture.authentication.authenticate(
    `Bearer ${await subject.clientToken()}`,
  );
  assert.ok(isMachineIdentity(client));
  assert.equal(client.instanceId, subject.instanceId);
  assert.equal(client.connectionId, subject.connectionId);
  assert.equal(
    subject.connections.get(subject.instanceId),
    subject.connectionId,
  );
});

test("gateway.jwt.unknown_claim refuses a claim outside the closed set", async (t) => {
  const subject = await fixtureOf(t);
  const claims = decode(subject.fixture.token).payload;
  await subject.refuse(
    await subject.signed({ ...claims, role: "admin" }),
    JwtCause.UnknownClaim,
  );
});

test("gateway.jwt.missing_claim refuses a token without a required claim", async (t) => {
  const subject = await fixtureOf(t);
  const claims: Record<string, unknown> = {
    ...decode(subject.fixture.token).payload,
  };
  delete claims.jti;
  await subject.refuse(await subject.signed(claims), JwtCause.MissingClaim);
  const client: Record<string, unknown> = {
    ...decode(await subject.clientToken()).payload,
  };
  delete client.project_id;
  await subject.refuse(await subject.signed(client), JwtCause.MissingClaim);
});

test("gateway.jwt.forbidden_claim refuses instance claims on another kind or placement", async (t) => {
  const subject = await fixtureOf(t);
  const human = decode(subject.fixture.token).payload;
  await subject.refuse(
    await subject.signed({ ...human, instance_id: subject.instanceId }),
    JwtCause.ForbiddenClaim,
  );
  const worker = decode(subject.workerToken).payload;
  await subject.refuse(
    await subject.signed({ ...worker, connection_id: subject.connectionId }),
    JwtCause.ForbiddenClaim,
  );
  await subject.refuse(
    await subject.clientToken({ resourceIdentity: SERVER_RESOURCE }),
    JwtCause.ForbiddenClaim,
  );
});

test("gateway.jwt.invalid_type refuses a claim of the wrong type or form", async (t) => {
  const subject = await fixtureOf(t);
  const human = decode(subject.fixture.token).payload;
  await subject.refuse(
    await subject.signed({ ...human, sub: 1 }),
    JwtCause.InvalidType,
  );
  await subject.refuse(
    await subject.signed({ ...human, kind: "robot" }),
    JwtCause.InvalidType,
  );
  const worker = decode(subject.workerToken).payload;
  await subject.refuse(
    await subject.signed({ ...worker, sub: `client_identity_${ulid()}` }),
    JwtCause.InvalidType,
  );
  const client = decode(await subject.clientToken()).payload;
  await subject.refuse(
    await subject.signed({ ...client, connection_id: "connection_x" }),
    JwtCause.InvalidType,
  );
});

test("gateway.jwt.expired and gateway.jwt.not_yet_issued refuse a token outside its time", async (t) => {
  const subject = await fixtureOf(t);
  const human = decode(subject.fixture.token).payload;
  const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  await subject.refuse(
    await subject.signed({ ...human, exp: now - 1 }),
    JwtCause.Expired,
  );
  await subject.refuse(
    await subject.signed({
      ...human,
      iat: now + SECONDS_PER_HOUR,
      exp: now + 2 * SECONDS_PER_HOUR,
    }),
    JwtCause.NotYetIssued,
  );
});

test("gateway.jwt.instance_ended refuses a token of an ended revision", async (t) => {
  const subject = await fixtureOf(t);
  const client = await subject.clientToken();
  subject.live.delete(subject.instanceId);
  await subject.refuse(subject.workerToken, JwtCause.InstanceEnded);
  await subject.refuse(client, JwtCause.InstanceEnded);
});

test("gateway.jwt.instance_required refuses a client token without instance claims at the worker placement", async (t) => {
  const subject = await fixtureOf(t);
  const claims: Record<string, unknown> = {
    ...decode(await subject.clientToken()).payload,
  };
  delete claims.instance_id;
  delete claims.connection_id;
  await subject.refuse(await subject.signed(claims), JwtCause.InstanceRequired);
});

test("gateway.jwt.connection_superseded refuses a client token of another connection", async (t) => {
  const subject = await fixtureOf(t);
  subject.connections.set(subject.instanceId, `connection_${ulid()}`);
  await subject.refuse(
    await subject.clientToken(),
    JwtCause.ConnectionSuperseded,
  );
});

test("gateway.jwt.instance_not_listed refuses an instance that the binding does not list", async (t) => {
  const subject = await fixtureOf(t);
  subject.listed.splice(0, subject.listed.length, OTHER_INSTANCE_NAME);
  await subject.refuse(await subject.clientToken(), JwtCause.InstanceNotListed);
  assert.equal(subject.connections.has(subject.instanceId), false);
});

test("an instance client token of a group with no listed instance needs a live registration of the group", async (t) => {
  const subject = await fixtureOf(t);
  const clientId = `client_identity_${ulid()}`;
  const token = await subject.clientToken({
    resourceIdentity: DRAINED_RESOURCE,
    clientId,
  });
  await assert.rejects(
    subject.fixture.authentication.authenticate(`Bearer ${token}`),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Unauthorized &&
      error.code === UNAUTHORIZED_CODE,
  );
  subject.lookups.worker.registrations.set(clientId, {
    client_id: clientId,
    name: INSTANCE_NAME,
    project_id: TEST_PROJECT_ID,
    resource_identity: DRAINED_RESOURCE,
    runtime_identity: `worker_registration_${ulid()}`,
    registered_at: Date.now(),
  });
  const identity = await subject.fixture.authentication.authenticate(
    `Bearer ${token}`,
  );
  assert.ok(isMachineIdentity(identity));
  assert.equal(identity.instanceId, subject.instanceId);
  subject.live.delete(subject.instanceId);
  await subject.refuse(token, JwtCause.InstanceEnded);
});
