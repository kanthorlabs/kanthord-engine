import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { decode, sign } from "hono/jwt";
import { ulid } from "ulid";
import { background } from "../../kernel/context.ts";
import { deriveKey } from "../../kernel/json.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { OperationError } from "../../kernel/errors.ts";
import {
  authenticationFixture,
  fakeLookups,
  gatewayFixture,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "../test-support.ts";
import {
  CLIENT_IDENTITY_PREFIX,
  IdentityKind,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_HUMAN_USERNAME_LENGTH,
} from "../../kernel/caller.ts";
import {
  generateGuestJWT,
  generateHumanJWT,
  generateMachineJWT,
} from "./jwt.ts";
import {
  isDelegateIdentity,
  isGuestIdentity,
  isHumanIdentity,
  isMachineIdentity,
  isReadOnlyIdentity,
  projectScopeOf,
} from "../../kernel/caller.ts";
import {
  testGuestIdentity,
  testReadOnlyIdentity,
} from "../../kernel/test-identity.ts";
import { gatewayOperations } from "../contract.ts";
import { JwtCause, WorkerGroupEnded } from "../errors.ts";
import { InstancePlacement } from "../../worker/contract.ts";

const TOKEN_LIFETIME = 600;
const MILLISECONDS_PER_SECOND = 1000;
const NO_REGISTRATIONS = 0;
const HUMAN_NAME = " Ulrich ";
const MACHINE_NAME = "Worker display";
const HUMAN_USERNAME = " ulrich ";
const refusedWith401 = (error: unknown) =>
  error instanceof OperationError &&
  error.status === HttpStatus.Unauthorized &&
  /^gateway\.(jwt\.|authentication\.unauthorized$)/.test(error.code);

async function tokenKey(masterKey: string) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(deriveKey(masterKey, "gateway/jwt-hs256/v1")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

test("issuance preserves human subjects and names, and generates fresh machine subjects and session identifiers", async (t) => {
  const fixture = await gatewayFixture(t, { lookups: fakeLookups() });
  const human = await generateHumanJWT(
    fixture.config.master_key,
    fixture.config.gateway.auth.version,
    TOKEN_LIFETIME,
    HUMAN_USERNAME,
    HUMAN_NAME,
  );
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${human.token}`,
  );
  assert.ok(isHumanIdentity(identity));
  assert.equal(identity.accountId, HUMAN_USERNAME);
  assert.equal(identity.name, HUMAN_NAME);
  const response = await fixture.request(gatewayOperations.verify.path, {
    headers: { Authorization: `Bearer ${human.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(await response.json(), {
    kind: IdentityKind.Human,
    sub: HUMAN_USERNAME,
    name: HUMAN_NAME,
  });
  const rechecked = await fixture.gateway.authentication.recheck(
    identity,
    background,
  );
  assert.deepEqual(rechecked, identity);
  assert.notEqual(rechecked, identity);
  const machine = await generateMachineJWT(
    fixture.config.master_key,
    fixture.config.gateway.auth.version,
    TOKEN_LIFETIME,
    { projectId: TEST_PROJECT_ID, bindingName: TEST_WORKER_BINDING },
  );
  const named = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
    MACHINE_NAME,
  );
  const claims = decode(machine.token).payload;
  const other = decode(named).payload;
  assert.ok(
    identitySchema(CLIENT_IDENTITY_PREFIX).safeParse(claims.sub).success,
  );
  assert.equal(claims.name, claims.sub);
  assert.equal(claims.kind, IdentityKind.Client);
  assert.equal(claims.project_id, TEST_PROJECT_ID);
  assert.equal(
    claims.resource_identity,
    `worker:kanthord:${TEST_WORKER_BINDING}`,
  );
  assert.ok(!("binding" in claims));
  assert.equal(claims.exp! - claims.iat!, TOKEN_LIFETIME);
  assert.equal(machine.expiresAt, claims.exp! * MILLISECONDS_PER_SECOND);
  assert.notEqual(claims.sub, other.sub);
  assert.notEqual(claims.jti, other.jti);
  const verified = await fixture.gateway.authentication.authenticate(
    `Bearer ${named}`,
  );
  assert.ok(isMachineIdentity(verified));
  assert.equal(verified.name, MACHINE_NAME);
  assert.equal(verified.projectId, TEST_PROJECT_ID);
  assert.equal(verified.resourceIdentity, other.resource_identity);
  assert.equal(verified.issuedAt, other.iat! * MILLISECONDS_PER_SECOND);
  assert.equal(verified.runtimeIdentity, undefined);
  assert.ok(Object.isFrozen(verified));
});

test("both token kinds reject invalid names, timestamps, session identifiers, signatures, algorithms and kinds", async (t) => {
  const machines = fakeLookups();
  const fixture = await authenticationFixture(t, machines);
  const key = await tokenKey(fixture.config.master_key);
  const tokens = [
    fixture.token,
    await fixture.machineToken(TEST_PROJECT_ID, TEST_WORKER_BINDING),
  ];
  const invalidClaims: Record<string, unknown>[] = [
    { name: undefined },
    { name: "" },
    { name: " \t" },
    { name: "n".repeat(MAX_DISPLAY_NAME_LENGTH + 1) },
    { name: 1 },
    { jti: undefined },
    { jti: 1 },
    { iat: undefined },
    { iat: 1.5 },
    { iat: Number.MAX_SAFE_INTEGER + 1 },
    { iat: "1" },
    { exp: undefined },
    { exp: 1.5 },
    { exp: Number.MAX_SAFE_INTEGER + 1 },
    { exp: "9999999999" },
    { exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) },
    { kind: "unknown" },
    { kind: undefined },
  ];
  for (const token of tokens) {
    const claims = decode(token).payload;
    for (const changes of invalidClaims) {
      const invalid = await sign({ ...claims, ...changes }, key, "HS256");
      await assert.rejects(
        fixture.authentication.authenticate(`Bearer ${invalid}`),
        refusedWith401,
      );
    }
    const wrongAlgorithm = await sign(claims, "test-algorithm-key", "HS512");
    await assert.rejects(
      fixture.authentication.authenticate(`Bearer ${wrongAlgorithm}`),
      refusedWith401,
    );
    await assert.rejects(
      fixture.authentication.authenticate(`Bearer ${token.slice(0, -3)}AAA`),
      refusedWith401,
    );
    for (const authorization of [
      undefined,
      "Basic invalid",
      `Bearer ${token},${token}`,
      `Bearer ${token} extra`,
    ])
      await assert.rejects(
        fixture.authentication.authenticate(authorization),
        refusedWith401,
      );
  }
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
});

test("human and machine claims enforce distinct subjects and binding rules", async (t) => {
  const fixture = await authenticationFixture(t, fakeLookups());
  const key = await tokenKey(fixture.config.master_key);
  const human = decode(fixture.token).payload;
  const machine = decode(
    await fixture.machineToken(TEST_PROJECT_ID, TEST_WORKER_BINDING),
  ).payload;
  const invalidHuman: Record<string, unknown>[] = [
    { sub: undefined },
    { sub: "" },
    { sub: " " },
    { sub: 123 },
    { sub: "u".repeat(MAX_HUMAN_USERNAME_LENGTH + 1) },
    { binding: TEST_WORKER_BINDING },
    { binding: null },
    { reg: "removed-claim" },
    { project_id: TEST_PROJECT_ID },
    { resource_identity: `worker:kanthord:${TEST_WORKER_BINDING}` },
  ];
  const invalidMachine: Record<string, unknown>[] = [
    { project_id: undefined },
    { project_id: "project_invalid" },
    { project_id: 123 },
    { resource_identity: undefined },
    { resource_identity: 123 },
    { resource_identity: "repository:github:org/repo" },
    { binding: "" },
    { binding: " " },
    { binding: 123 },
    { sub: undefined },
    { sub: ulid() },
    { sub: `project_${ulid()}` },
    { sub: String(machine.sub).toLowerCase() },
    { sub: 123 },
  ];
  for (const [base, invalid] of [
    [human, invalidHuman],
    [machine, invalidMachine],
  ] as const) {
    for (const changes of invalid) {
      const token = await sign({ ...base, ...changes }, key, "HS256");
      await assert.rejects(
        fixture.authentication.authenticate(`Bearer ${token}`),
        refusedWith401,
      );
    }
    const token = await sign(
      { ...base, name: "n".repeat(MAX_DISPLAY_NAME_LENGTH) },
      key,
      "HS256",
    );
    assert.equal(
      (await fixture.authentication.authenticate(`Bearer ${token}`)).name
        .length,
      MAX_DISPLAY_NAME_LENGTH,
    );
  }
  for (const value of ["", " ", "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)]) {
    await assert.rejects(
      generateHumanJWT(
        fixture.config.master_key,
        fixture.config.gateway.auth.version,
        TOKEN_LIFETIME,
        HUMAN_USERNAME,
        value,
      ),
      /name:/,
    );
    await assert.rejects(
      generateMachineJWT(
        fixture.config.master_key,
        fixture.config.gateway.auth.version,
        TOKEN_LIFETIME,
        { projectId: TEST_PROJECT_ID, bindingName: TEST_WORKER_BINDING },
        value,
      ),
      /name:/,
    );
  }
  await assert.rejects(
    generateMachineJWT(
      fixture.config.master_key,
      fixture.config.gateway.auth.version,
      TOKEN_LIFETIME,
      {
        projectId: TEST_PROJECT_ID,
        bindingName: " ",
      },
    ),
    /binding:/,
  );
});

test("binding collaborator failures propagate instead of becoming invalid credentials", async (t) => {
  const machines = fakeLookups();
  const failure = new Error("binding lookup failed");
  t.mock.method(machines.project, "resolveWorkerGroup", async () => {
    throw failure;
  });
  const fixture = await authenticationFixture(t, machines);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    (error) => error === failure,
  );
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
});

test("machine resolution receives issuance milliseconds and rechecks group availability", async (t) => {
  const machines = fakeLookups();
  const resolve = t.mock.method(machines.project, "resolveWorkerGroup");
  const fixture = await authenticationFixture(t, machines);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const identity = await fixture.authentication.authenticate(`Bearer ${token}`);
  assert.deepEqual(resolve.mock.calls[0]!.arguments, [
    TEST_PROJECT_ID,
    `worker:kanthord:${TEST_WORKER_BINDING}`,
    decode(token).payload.iat! * MILLISECONDS_PER_SECOND,
    background,
  ]);
  resolve.mock.mockImplementation(async () => null);
  await assert.rejects(
    fixture.authentication.recheck(identity, background),
    /Authentication required/,
  );
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    /Authentication required/,
  );
});

test("machine issuance validates the project identity and binding name", async (t) => {
  const fixture = await authenticationFixture(t);
  await assert.rejects(
    generateMachineJWT(
      fixture.config.master_key,
      fixture.config.gateway.auth.version,
      TOKEN_LIFETIME,
      {
        projectId: "invalid",
        bindingName: TEST_WORKER_BINDING,
      },
    ),
    { code: "gateway.authentication.invalid_project" },
  );
  await assert.rejects(
    generateMachineJWT(
      fixture.config.master_key,
      fixture.config.gateway.auth.version,
      TOKEN_LIFETIME,
      {
        projectId: TEST_PROJECT_ID,
        bindingName: " ",
      },
    ),
    { code: "gateway.authentication.invalid_binding" },
  );
});

test("only successful authentication of a live registration renews its heartbeat", async (t) => {
  const machines = fakeLookups();
  const heartbeat = t.mock.method(machines.worker, "heartbeat");
  const fixture = await authenticationFixture(t, machines);
  await fixture.authentication.authenticate(`Bearer ${fixture.token}`);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const identity = await fixture.authentication.authenticate(`Bearer ${token}`);
  assert.ok(isMachineIdentity(identity));
  assert.equal(heartbeat.mock.calls.length, NO_REGISTRATIONS);
  const runtimeIdentity = "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  machines.worker.registrations.set(identity.clientId, {
    client_id: identity.clientId,
    name: identity.name,
    project_id: identity.projectId,
    resource_identity: identity.resourceIdentity,
    runtime_identity: runtimeIdentity,
    registered_at: Date.now(),
  });
  await fixture.authentication.authenticate(`Bearer ${token}`);
  const once = 1;
  assert.equal(heartbeat.mock.calls.length, once);
  assert.deepEqual(heartbeat.mock.calls[0]!.arguments, [runtimeIdentity]);
  await assert.rejects(
    fixture.authentication.recheck(identity, background),
    /Authentication required/,
  );
  assert.equal(heartbeat.mock.calls.length, once);
  const current = await fixture.authentication.recheck(
    identity,
    background,
    false,
  );
  assert.ok(isMachineIdentity(current));
  assert.equal(current.runtimeIdentity, runtimeIdentity);
  const twice = 2;
  assert.equal(heartbeat.mock.calls.length, twice);
  await fixture.authentication.recheck(current, background);
  const threeTimes = 3;
  assert.equal(heartbeat.mock.calls.length, threeTimes);
  machines.worker.registrations.set(identity.clientId, {
    client_id: identity.clientId,
    name: identity.name,
    project_id: identity.projectId,
    runtime_identity: runtimeIdentity,
    registered_at: Date.now(),
    resource_identity: "worker:kanthord:other",
  });
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    /Authentication required/,
  );
  assert.equal(heartbeat.mock.calls.length, threeTimes);
});

const UNAUTHORIZED_CODE = "gateway.authentication.unauthorized";
const isPlainUnauthorized = (error: unknown) =>
  error instanceof OperationError &&
  !(error instanceof WorkerGroupEnded) &&
  error.status === HttpStatus.Unauthorized &&
  error.code === UNAUTHORIZED_CODE;

test("an ended worker group throws WorkerGroupEnded on authentication and recheck", async (t) => {
  const machines = fakeLookups();
  const fixture = await authenticationFixture(t, machines);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const identity = await fixture.authentication.authenticate(`Bearer ${token}`);
  const resolve = t.mock.method(
    machines.project,
    "resolveWorkerGroup",
    async () => null,
  );
  const ended = t.mock.method(
    machines.project,
    "workerGroupEnded",
    async () => true,
  );
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    (error) => error instanceof WorkerGroupEnded,
  );
  await assert.rejects(
    fixture.authentication.recheck(identity, background),
    (error) => error instanceof WorkerGroupEnded,
  );
  assert.deepEqual(ended.mock.calls[0]!.arguments, [
    ...resolve.mock.calls[0]!.arguments,
  ]);
});

test("a native group with no listed instance admits a client identity with a live registration and refuses one without", async (t) => {
  const machines = fakeLookups();
  t.mock.method(machines.project, "resolveWorkerGroup", async () => ({
    project_id: TEST_PROJECT_ID,
    resource_identity: `worker:kanthord:${TEST_WORKER_BINDING}`,
    worker_instances: [],
  }));
  const fixture = await authenticationFixture(t, machines);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    isPlainUnauthorized,
  );
  const [, payload] = token.split(".");
  const clientId = JSON.parse(
    Buffer.from(payload!, "base64url").toString("utf8"),
  ).sub as string;
  const runtimeIdentity = "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  machines.worker.registrations.set(clientId, {
    client_id: clientId,
    name: MACHINE_NAME,
    project_id: TEST_PROJECT_ID,
    resource_identity: `worker:kanthord:${TEST_WORKER_BINDING}`,
    runtime_identity: runtimeIdentity,
    registered_at: Date.now(),
  });
  const identity = await fixture.authentication.authenticate(`Bearer ${token}`);
  assert.ok(isMachineIdentity(identity));
  assert.equal(identity.runtimeIdentity, runtimeIdentity);
  await fixture.authentication.recheck(identity, background);
  machines.worker.registrations.set(clientId, {
    ...machines.worker.registrations.get(clientId)!,
    resource_identity: "worker:kanthord:other",
  });
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    isPlainUnauthorized,
  );
});

test("a failure that is no ended group keeps the plain 401", async (t) => {
  const machines = fakeLookups();
  const fixture = await authenticationFixture(t, machines);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const identity = await fixture.authentication.authenticate(`Bearer ${token}`);
  assert.ok(isMachineIdentity(identity));
  const ended = t.mock.method(
    machines.project,
    "workerGroupEnded",
    async () => true,
  );
  const resolve = t.mock.method(machines.project, "resolveWorkerGroup");

  resolve.mock.mockImplementation(async () => null);
  ended.mock.mockImplementation(async () => false);
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    isPlainUnauthorized,
  );

  resolve.mock.mockImplementation(async (_project, resource) => ({
    project_id: "project_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    resource_identity: resource,
  }));
  ended.mock.mockImplementation(async () => true);
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    isPlainUnauthorized,
  );

  resolve.mock.restore();
  machines.worker.registrations.set(identity.clientId, {
    client_id: identity.clientId,
    name: identity.name,
    project_id: identity.projectId,
    resource_identity: "worker:kanthord:other",
    runtime_identity: "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    registered_at: Date.now(),
  });
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${token}`),
    isPlainUnauthorized,
  );

  const old = await generateMachineJWT(
    fixture.config.master_key,
    fixture.config.gateway.auth.version + 1,
    TOKEN_LIFETIME,
    { projectId: TEST_PROJECT_ID, bindingName: TEST_WORKER_BINDING },
  );
  await assert.rejects(
    fixture.authentication.authenticate(`Bearer ${old.token}`),
    isPlainUnauthorized,
  );
});

const INSTANCE_NAME = "coder-1";
const INSTANCE_RESOURCE = `worker:kanthord:${TEST_WORKER_BINDING}`;

async function instanceFixture(t: TestContext, placement: InstancePlacement) {
  const instanceId = identitySchema("worker_instance").parse(
    `worker_instance_${ulid()}`,
  );
  const connectionId = `connection_${ulid()}`;
  const machines = {
    ...fakeLookups(),
    instances: {
      liveInstance: (id: string) =>
        id === instanceId
          ? { id, name: INSTANCE_NAME, worker: "coder@1", placement }
          : null,
      holdConnection: () => true,
    },
  };
  t.mock.method(machines.project, "resolveWorkerGroup", async () => ({
    project_id: TEST_PROJECT_ID,
    resource_identity: INSTANCE_RESOURCE,
    placement,
    worker_instances: [INSTANCE_NAME],
  }));
  const fixture = await authenticationFixture(t, machines);
  const key = await tokenKey(fixture.config.master_key);
  const claims = decode(
    await fixture.machineToken(TEST_PROJECT_ID, TEST_WORKER_BINDING),
  ).payload;
  const token = (overrides: Record<string, unknown>) =>
    sign({ ...claims, name: INSTANCE_NAME, ...overrides }, key, "HS256");
  const refuse = async (bearer: string, cause: JwtCause) =>
    assert.rejects(
      fixture.authentication.authenticate(`Bearer ${bearer}`),
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Unauthorized &&
        error.code === `gateway.jwt.${cause}`,
    );
  return { fixture, instanceId, connectionId, token, refuse };
}

test("a machine token of a server instance needs instance_id and no connection_id", async (t) => {
  for (const placement of [
    InstancePlacement.Server,
    InstancePlacement.Container,
  ]) {
    const subject = await instanceFixture(t, placement);
    const identity = await subject.fixture.authentication.authenticate(
      `Bearer ${await subject.token({ instance_id: subject.instanceId })}`,
    );
    assert.ok(isMachineIdentity(identity));
    assert.equal(identity.instanceId, subject.instanceId);
    assert.equal(identity.connectionId, undefined);
    await subject.refuse(await subject.token({}), JwtCause.InstanceRequired);
    await subject.refuse(
      await subject.token({
        instance_id: subject.instanceId,
        connection_id: subject.connectionId,
      }),
      JwtCause.ForbiddenClaim,
    );
  }
});

test("a machine token of a worker instance still needs connection_id", async (t) => {
  const subject = await instanceFixture(t, InstancePlacement.Worker);
  await subject.refuse(
    await subject.token({ instance_id: subject.instanceId }),
    JwtCause.InstanceRequired,
  );
  const identity = await subject.fixture.authentication.authenticate(
    `Bearer ${await subject.token({
      instance_id: subject.instanceId,
      connection_id: subject.connectionId,
    })}`,
  );
  assert.ok(isMachineIdentity(identity));
  assert.equal(identity.connectionId, subject.connectionId);
});

const GUEST_NAME = "Mira";
const GUEST_LIFETIME_MS = 600_000;
const INVITER = "ulrich";

async function guestFixture(t: TestContext) {
  const machines = fakeLookups();
  const fixture = await authenticationFixture(t, machines);
  const key = await tokenKey(fixture.config.master_key);
  const inviteId = `workbench_invite_${ulid()}`;
  const sessionId = `workbench_session_${ulid()}`;
  const guestId = `workbench_guest_${ulid()}`;
  const expiresAt = Date.now() + GUEST_LIFETIME_MS;
  const projectIds = [`project_${ulid()}`];
  machines.workbench.invites.set(inviteId, {
    session_id: sessionId,
    invited_by: INVITER,
    expires_at: expiresAt,
    project_ids: projectIds,
    granted_operations: [],
  });
  const issued = await generateGuestJWT(
    fixture.config.master_key,
    fixture.config.gateway.auth.version,
    { guestId, name: GUEST_NAME, inviteId, expiresAt },
  );
  const claims = decode(issued.token).payload;
  const forged = (changes: Record<string, unknown>) =>
    sign({ ...claims, ...changes }, key, "HS256");
  const refuse = (bearer: string, code: string) =>
    assert.rejects(
      fixture.authentication.authenticate(`Bearer ${bearer}`),
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Unauthorized &&
        error.code === code,
    );
  return {
    machines,
    fixture,
    key,
    inviteId,
    sessionId,
    guestId,
    projectIds,
    expiresAt,
    issued,
    claims,
    forged,
    refuse,
  };
}

test("a guest token signs sub, name, kind and invite_id with the exp of the invite, and authenticates to a guest identity", async (t) => {
  const g = await guestFixture(t);
  assert.equal(g.claims.sub, g.guestId);
  assert.equal(g.claims.name, GUEST_NAME);
  assert.equal(g.claims.kind, IdentityKind.Guest);
  assert.equal(g.claims.invite_id, g.inviteId);
  assert.equal(g.claims.exp, Math.floor(g.expiresAt / MILLISECONDS_PER_SECOND));
  const identity = await g.fixture.authentication.authenticate(
    `Bearer ${g.issued.token}`,
  );
  assert.ok(isGuestIdentity(identity));
  assert.equal(identity.guestId, g.guestId);
  assert.equal(identity.inviteId, g.inviteId);
  assert.equal(identity.sessionId, g.sessionId);
  assert.equal(identity.invitedBy, INVITER);
});

test("a guest token without invite_id answers gateway.jwt.missing_claim", async (t) => {
  const g = await guestFixture(t);
  await g.refuse(
    await g.forged({ invite_id: undefined }),
    `gateway.jwt.${JwtCause.MissingClaim}`,
  );
});

test("a guest token with a machine or instance claim answers gateway.jwt.forbidden_claim", async (t) => {
  const g = await guestFixture(t);
  for (const claim of [
    { project_id: TEST_PROJECT_ID },
    { resource_identity: `worker:kanthord:${TEST_WORKER_BINDING}` },
    { instance_id: `worker_instance_${ulid()}` },
    { connection_id: `connection_${ulid()}` },
  ])
    await g.refuse(
      await g.forged(claim),
      `gateway.jwt.${JwtCause.ForbiddenClaim}`,
    );
});

test("a human, worker or client token with invite_id answers 401", async (t) => {
  const g = await guestFixture(t);
  const human = decode(g.fixture.token).payload;
  const client = decode(
    await g.fixture.machineToken(TEST_PROJECT_ID, TEST_WORKER_BINDING),
  ).payload;
  const instanceId = `worker_instance_${ulid()}`;
  const worker = { ...human, sub: instanceId, kind: IdentityKind.Worker };
  for (const claims of [human, worker, client])
    await g.refuse(
      await sign({ ...claims, invite_id: g.inviteId }, g.key, "HS256"),
      `gateway.jwt.${JwtCause.ForbiddenClaim}`,
    );
});

test("a guest token of a deleted invite answers gateway.jwt.invite_ended", async (t) => {
  const g = await guestFixture(t);
  g.machines.workbench.invites.delete(g.inviteId);
  await g.refuse(g.issued.token, `gateway.jwt.${JwtCause.InviteEnded}`);
});

test("a guest token with a future exp and an invite row that expired answers gateway.jwt.invite_ended", async (t) => {
  const g = await guestFixture(t);
  g.machines.workbench.invites.set(g.inviteId, {
    session_id: g.sessionId,
    invited_by: INVITER,
    expires_at: Date.now() - 1,
    project_ids: g.projectIds,
    granted_operations: [],
  });
  await g.refuse(g.issued.token, `gateway.jwt.${JwtCause.InviteEnded}`);
});

test("a guest token past exp answers gateway.jwt.expired", async (t) => {
  const g = await guestFixture(t);
  const expired = await generateGuestJWT(
    g.fixture.config.master_key,
    g.fixture.config.gateway.auth.version,
    {
      guestId: g.guestId,
      name: GUEST_NAME,
      inviteId: g.inviteId,
      expiresAt: Date.now() - GUEST_LIFETIME_MS,
    },
  );
  await g.refuse(expired.token, `gateway.jwt.${JwtCause.Expired}`);
});

test("recheck of a guest identity whose invite row is gone answers gateway.jwt.invite_ended", async (t) => {
  const g = await guestFixture(t);
  const identity = await g.fixture.authentication.authenticate(
    `Bearer ${g.issued.token}`,
  );
  const rechecked = await g.fixture.authentication.recheck(
    identity,
    background,
  );
  assert.ok(isGuestIdentity(rechecked));
  g.machines.workbench.invites.delete(g.inviteId);
  await assert.rejects(
    g.fixture.authentication.recheck(identity, background),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Unauthorized &&
      error.code === `gateway.jwt.${JwtCause.InviteEnded}`,
  );
});

test("a guest identity from the factory passes isGuestIdentity and fails isHumanIdentity, and a copied object passes neither", () => {
  const guest = testGuestIdentity({
    guestId: `workbench_guest_${ulid()}`,
    name: GUEST_NAME,
    inviteId: `workbench_invite_${ulid()}`,
    sessionId: `workbench_session_${ulid()}`,
    invitedBy: INVITER,
    reader: testReadOnlyIdentity(INVITER, {
      inviteId: `workbench_invite_${ulid()}`,
      projectIds: [],
      guestName: GUEST_NAME,
    }),
    jti: ulid(),
  });
  assert.ok(isGuestIdentity(guest));
  assert.ok(!isHumanIdentity(guest));
  const copy = { ...guest };
  assert.ok(!isGuestIdentity(copy));
  assert.ok(!isHumanIdentity(copy));
});

test("(security) guest verification mints the reader with the project_ids of the row", async (t) => {
  const g = await guestFixture(t);
  const identity = await g.fixture.authentication.authenticate(
    `Bearer ${g.issued.token}`,
  );
  assert.ok(isGuestIdentity(identity));
  assert.ok(isReadOnlyIdentity(identity.reader));
  assert.equal(identity.reader.accountId, INVITER);
  assert.deepEqual([...projectScopeOf(identity.reader)!], g.projectIds);
});

test("(security) recheck re-mints the read-only identity with the live project_ids", async (t) => {
  const g = await guestFixture(t);
  const identity = await g.fixture.authentication.authenticate(
    `Bearer ${g.issued.token}`,
  );
  assert.ok(isGuestIdentity(identity));
  const liveIds = [`project_${ulid()}`, `project_${ulid()}`];
  g.machines.workbench.invites.set(g.inviteId, {
    session_id: g.sessionId,
    invited_by: INVITER,
    expires_at: g.expiresAt,
    project_ids: liveIds,
    granted_operations: [],
  });
  const rechecked = await g.fixture.authentication.recheck(
    identity.reader,
    background,
  );
  assert.ok(isReadOnlyIdentity(rechecked));
  assert.deepEqual([...projectScopeOf(rechecked)!], liveIds);
});

test("(security) after a revoke, recheck of the read-only identity answers 401", async (t) => {
  const g = await guestFixture(t);
  const identity = await g.fixture.authentication.authenticate(
    `Bearer ${g.issued.token}`,
  );
  assert.ok(isGuestIdentity(identity));
  g.machines.workbench.invites.delete(g.inviteId);
  await assert.rejects(
    g.fixture.authentication.recheck(identity.reader, background),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Unauthorized,
  );
});

test("(security) recheck of a delegate identity answers 401", async (t) => {
  const g = await guestFixture(t);
  const identity = await g.fixture.authentication.authenticate(
    `Bearer ${g.issued.token}`,
  );
  assert.ok(isGuestIdentity(identity));
  g.machines.workbench.claimAnswer = {
    invitedBy: INVITER,
    projectIds: g.projectIds,
  };
  const delegate = g.fixture.authentication.delegateOf(
    identity.reader,
    { sessionId: g.sessionId, toolCallId: "call-1" },
    { operationId: "mission.node.pause", input: {} },
  );
  assert.ok(isDelegateIdentity(delegate));
  assert.equal(delegate.accountId, INVITER);
  assert.deepEqual([...projectScopeOf(delegate)!], g.projectIds);
  await assert.rejects(
    g.fixture.authentication.recheck(delegate, background),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Unauthorized,
  );
});
