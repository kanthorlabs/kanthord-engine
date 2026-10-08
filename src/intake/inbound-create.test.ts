import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { ulid } from "ulid";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  OperationRegistry,
  OperationResultType,
  type CallerContext,
} from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundKind,
  InboundPlatform,
  intakeOperations,
  type InboundCreate,
} from "./contract.ts";
import { commitInbound, credentialRefusal } from "./inbound-create.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN_PROJECT_ID = "project_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const RESOURCE = "owner/repo";
const VALIDATION_FAILED = "gateway.request.validation_failed";
const PROJECT_NOT_FOUND = "intake.inbound.project_not_found";
const CREDENTIAL_INVALID = "intake.inbound.credential_invalid";
const CREDENTIAL_NOT_FOUND = "credential.credential.not_found";
const PLATFORM_MISMATCH = "credential.platform.mismatch";
const CREDENTIAL_INVALID_STATUS = 422;
const NO_ROWS = 0;
const ONE_ROW = 1;
const TWO_ROWS = 2;
const ONE_CALL = 1;
const CREDENTIAL_NAME = "token";

const WEBHOOK: InboundCreate = {
  project_id: PROJECT_ID,
  kind: InboundKind.Webhook,
  platform: InboundPlatform.GitHub,
  consumer: Consumer.MissionDeliveryAdmit,
  configuration: { resource: RESOURCE },
};

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const projectCalls: { projectId: string; identity: unknown }[] = [];
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...unusedActionDependencies(),
    projects: {
      get: async (input, options) => {
        projectCalls.push({
          projectId: input.params.project_id,
          identity: options?.identity,
        });
        if (input.params.project_id !== PROJECT_ID)
          return {
            type: OperationResultType.Failure,
            status: HttpStatus.NotFound,
            error: {
              error: {
                code: "project.project.not_found",
                message: "Project not found.",
                details: null,
              },
              request_id: createIdentity("request"),
            },
          };
        return {
          type: OperationResultType.Completed,
          status: HttpStatus.OK,
          data: {
            id: PROJECT_ID,
            name: "inbounds",
            binding_set_version: 1,
            created_at: 1,
            workspace_directory: "/workspace",
          },
        };
      },
    },
  });
  const registry = new OperationRegistry();
  intake.declare(registry);
  const identity = testHumanIdentity("ulrich", "Ulrich", ulid());
  const caller: CallerContext = {
    identity,
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const operation = intakeOperations["inbound.create"];
  const create = async (body: Record<string, unknown>) =>
    operation.output.parse(
      await registry
        .get(operation.id)
        .handler(
          operation.input.parse({ params: {}, query: {}, body }),
          caller,
        ),
    );
  const rows = () =>
    store.transaction(
      (tx) =>
        tx.database
          .prepare("SELECT id, credential, checkpoint FROM intake_inbound")
          .all() as {
          id: string;
          credential: string | null;
          checkpoint: string | null;
        }[],
    );
  return { store, identity, projectCalls, create, rows };
}

async function refusesWith(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<OperationError> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof OperationError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return error;
}

test("a webhook inbound inserts one row with no platform call and answers the allocated identity", async (t) => {
  const h = harness(t);
  const inbound = await h.create(WEBHOOK);
  assert.match(inbound.id, /^inbound_/);
  assert.equal(inbound.kind, InboundKind.Webhook);
  assert.equal(inbound.credential, null);
  assert.equal(inbound.checkpoint, null);
  assert.deepEqual(inbound.configuration, { resource: RESOURCE });
  assert.deepEqual(
    h.rows().map((row) => ({ ...row })),
    [{ id: inbound.id, credential: null, checkpoint: null }],
  );
  assert.equal(h.projectCalls.length, ONE_CALL);
  assert.deepEqual(h.projectCalls[0], {
    projectId: PROJECT_ID,
    identity: h.identity,
  });
});

test("a webhook with a credential answers 400 and inserts nothing", async (t) => {
  const h = harness(t);
  const error = await refusesWith(
    h.create({ ...WEBHOOK, credential: "github-token" }),
    HttpStatus.BadRequest,
    VALIDATION_FAILED,
  );
  assert.deepEqual(error.details, [
    { path: ["body", "credential"], code: "custom" },
  ]);
  assert.equal(h.rows().length, NO_ROWS);
});

test("a poll answers 400 until the poll create exists and inserts nothing", async (t) => {
  const h = harness(t);
  await refusesWith(
    h.create({ ...WEBHOOK, kind: InboundKind.Poll, credential: "token" }),
    HttpStatus.BadRequest,
    VALIDATION_FAILED,
  );
  assert.equal(h.rows().length, NO_ROWS);
});

test("an unknown project answers 404 and inserts nothing", async (t) => {
  const h = harness(t);
  await refusesWith(
    h.create({ ...WEBHOOK, project_id: UNKNOWN_PROJECT_ID }),
    HttpStatus.NotFound,
    PROJECT_NOT_FOUND,
  );
  assert.equal(h.rows().length, NO_ROWS);
});

test("an unknown consumer fails the body schema", () => {
  const parsed = intakeOperations["inbound.create"].input.safeParse({
    params: {},
    query: {},
    body: { ...WEBHOOK, consumer: "mission.node.check" },
  });
  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error?.issues.map((issue) => issue.path),
    [["body", "consumer"]],
  );
});

test("an extra configuration field answers 400 with no project call and inserts nothing", async (t) => {
  const h = harness(t);
  const error = await refusesWith(
    h.create({
      ...WEBHOOK,
      configuration: { resource: RESOURCE, events: ["push"] },
    }),
    HttpStatus.BadRequest,
    VALIDATION_FAILED,
  );
  assert.deepEqual(error.details, [
    { path: ["body", "configuration"], code: "unrecognized_keys" },
  ]);
  assert.equal(h.projectCalls.length, NO_ROWS);
  assert.equal(h.rows().length, NO_ROWS);
});

test("two equal creates insert two rows", async (t) => {
  const h = harness(t);
  const first = await h.create(WEBHOOK);
  const second = await h.create(WEBHOOK);
  assert.notEqual(first.id, second.id);
  assert.equal(h.rows().length, TWO_ROWS);
});

test("the insert step maps an unknown or unsuitable credential to 422", async (t) => {
  const h = harness(t);
  for (const code of [CREDENTIAL_NOT_FOUND, PLATFORM_MISMATCH]) {
    const custody = {
      custodySuitability: () => {
        throw new OperationError(HttpStatus.NotFound, code, "Refused.");
      },
    };
    assert.throws(
      () =>
        h.store.transaction((tx) =>
          commitInbound(
            custody,
            tx,
            createIdentity("inbound"),
            { ...WEBHOOK, kind: InboundKind.Poll, credential: "token" },
            null,
          ),
        ),
      (error) =>
        error instanceof OperationError &&
        error.status === CREDENTIAL_INVALID_STATUS &&
        error.code === CREDENTIAL_INVALID,
    );
  }
  assert.equal(h.rows().length, NO_ROWS);
});

test("credentialRefusal maps the custody refusals and passes every other error", () => {
  for (const code of [CREDENTIAL_NOT_FOUND, PLATFORM_MISMATCH]) {
    const mapped = credentialRefusal(
      new OperationError(HttpStatus.BadRequest, code, "Refused."),
    );
    assert.ok(mapped instanceof OperationError);
    assert.equal(mapped.status, CREDENTIAL_INVALID_STATUS);
    assert.equal(mapped.code, CREDENTIAL_INVALID);
  }
  const other = new OperationError(
    HttpStatus.Conflict,
    "credential.credential.archived",
    "Archived.",
  );
  assert.equal(credentialRefusal(other), other);
  const plain = new Error("boom");
  assert.equal(credentialRefusal(plain), plain);
});

test("the insert step checks a named credential and inserts the row", async (t) => {
  const h = harness(t);
  const requests: unknown[] = [];
  const custody = {
    custodySuitability: (_tx: unknown, request: unknown) => {
      requests.push(request);
    },
  };
  const id = createIdentity("inbound");
  const inbound = h.store.transaction((tx) =>
    commitInbound(
      custody,
      tx,
      id,
      { ...WEBHOOK, kind: InboundKind.Poll, credential: "token" },
      { since: 1 },
    ),
  );
  assert.equal(inbound.id, id);
  assert.equal(inbound.credential, CREDENTIAL_NAME);
  assert.deepEqual(inbound.checkpoint, { since: 1 });
  assert.deepEqual(requests, [
    { credential: "token", platform: InboundPlatform.GitHub },
  ]);
  assert.equal(h.rows().length, ONE_ROW);
});
