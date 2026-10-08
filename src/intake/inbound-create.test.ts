import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { ulid } from "ulid";
import {
  GrantKind,
  type GrantOf,
  type GrantRequest,
  type Material,
} from "../custody/contract.ts";
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
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  GitHubPlatform,
  type GitHubAnswer,
  type GitHubCall,
  type GitHubEventsAnswer,
  type GitHubEventsQuery,
} from "../repository/github.ts";
import type { IntakeCustody } from "./action-check.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundKind,
  InboundPlatform,
  intakeOperations,
  ResultClass,
  type InboundCreate,
} from "./contract.ts";
import { commitInbound, credentialRefusal } from "./inbound-create.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import type { Dependencies } from "./service.ts";
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
const PLATFORM_REFUSED = "intake.inbound.platform_refused";
const POLL_CREDENTIAL = "github-poll";
const OTHER_PLATFORM_CREDENTIAL = "s3-store";
const UNKNOWN_CREDENTIAL = "missing";
const POLL_TOKEN = "ghp_poll-token";
const UNAUTHORIZED_STATUS = 401;
const ETAG = '"etag-1"';
const CLOSED_LOCAL_PORT = "http://127.0.0.1:9";

const WEBHOOK: InboundCreate = {
  project_id: PROJECT_ID,
  kind: InboundKind.Webhook,
  platform: InboundPlatform.GitHub,
  consumer: Consumer.MissionDeliveryAdmit,
  configuration: { resource: RESOURCE },
};

function harness(
  t: TestContext,
  collaborations: Partial<Pick<Dependencies, "custody" | "github">> = {},
) {
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
    ...collaborations,
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
  return { store, intake, identity, projectCalls, create, rows };
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

test("a poll without a credential answers 400 and inserts nothing", async (t) => {
  const h = harness(t);
  const error = await refusesWith(
    h.create({ ...WEBHOOK, kind: InboundKind.Poll }),
    HttpStatus.BadRequest,
    VALIDATION_FAILED,
  );
  assert.deepEqual(error.details, [
    { path: ["body", "credential"], code: "custom" },
  ]);
  assert.equal(h.projectCalls.length, NO_ROWS);
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

const POLL: InboundCreate = {
  ...WEBHOOK,
  kind: InboundKind.Poll,
  credential: POLL_CREDENTIAL,
};

type EventsAnswer = GitHubAnswer<GitHubEventsAnswer>;

function fakeCustody(credentials: Map<string, string>) {
  const drops: string[] = [];
  const refuse = (code: string): never => {
    throw new OperationError(HttpStatus.BadRequest, code, "Refused.");
  };
  const custodySuitability = (
    _tx: Transaction,
    request: { credential: string; platform: string },
  ): void => {
    const platform = credentials.get(request.credential);
    if (platform === undefined) refuse(CREDENTIAL_NOT_FOUND);
    if (platform !== request.platform) refuse(PLATFORM_MISMATCH);
  };
  const custody: IntakeCustody = {
    custodySuitability,
    authorizeOperation<R extends GrantRequest>(
      tx: Transaction,
      request: R,
    ): GrantOf<R["kind"]> {
      const inbound: GrantRequest = request;
      assert.ok(inbound.kind === GrantKind.Inbound);
      assert.equal(inbound.identity.service, INTAKE_SERVICE_NAME);
      custodySuitability(tx, inbound.inbound);
      const grant: GrantOf<typeof GrantKind.Inbound> = {
        kind: GrantKind.Inbound,
        credential: inbound.inbound.credential,
        platform: inbound.inbound.platform,
        project_id: inbound.inbound.projectId,
        execution: null,
        facts: {
          inbound_id: inbound.inbound.inboundId,
          resource: inbound.inbound.resource,
        },
      };
      return grant as GrantOf<R["kind"]>;
    },
    release(tx, grant): Material {
      const credential = grant.credential;
      assert.ok(credential !== null);
      custodySuitability(tx, { credential, platform: grant.platform });
      tx.database
        .prepare("INSERT INTO test_drain (credential) VALUES (?)")
        .run(credential);
      return {
        credential_id: "credential_1",
        platform: grant.platform,
        value: () => ({ key: POLL_TOKEN }),
        drop: () => drops.push(credential),
      };
    },
    consume: () => assert.fail("A poll create consumes no grant."),
    grantFacts: () => assert.fail("A poll create reads no grant facts."),
  };
  return { custody, drops };
}

function pollHarness(
  t: TestContext,
  answer: (call: GitHubCall, query: GitHubEventsQuery) => Promise<EventsAnswer>,
) {
  const credentials = new Map([
    [POLL_CREDENTIAL, InboundPlatform.GitHub],
    [OTHER_PLATFORM_CREDENTIAL, "s3"],
  ]);
  const { custody, drops } = fakeCustody(credentials);
  const github = new GitHubPlatform({ baseUrl: CLOSED_LOCAL_PORT });
  const listEvents = t.mock.method(github, "listEvents", answer);
  const h = harness(t, { custody, github });
  h.store.transaction((tx) =>
    tx.database.exec("CREATE TABLE test_drain (credential TEXT NOT NULL)"),
  );
  const start = t.mock.method(h.intake.pollLoops, "start");
  const drained = () =>
    h.store.transaction(
      (tx) =>
        tx.database.prepare("SELECT credential FROM test_drain").all().length,
    );
  return { ...h, credentials, drops, listEvents, start, drained };
}

const modified: EventsAnswer = {
  ok: true,
  value: { notModified: false, etag: ETAG, events: [] },
};

test("a poll create performs one request with the credential and inserts one row", async (t) => {
  const h = pollHarness(t, async () => modified);
  const inbound = await h.create(POLL);
  assert.equal(inbound.kind, InboundKind.Poll);
  assert.equal(inbound.credential, POLL_CREDENTIAL);
  assert.equal(inbound.checkpoint, null);
  assert.deepEqual(
    h.rows().map((row) => ({ ...row })),
    [{ id: inbound.id, credential: POLL_CREDENTIAL, checkpoint: null }],
  );
  assert.equal(h.listEvents.mock.callCount(), ONE_CALL);
  const [call, query] = h.listEvents.mock.calls[0]?.arguments ?? [];
  assert.equal(call?.token, POLL_TOKEN);
  assert.equal(call?.requester, h.identity);
  assert.deepEqual(query, { owner: "owner", repo: "repo", etag: null });
  assert.deepEqual(h.drops, [POLL_CREDENTIAL]);
  assert.equal(h.drained(), ONE_ROW);
});

test("a poll create starts one loop after the insert and a webhook starts none", async (t) => {
  const h = pollHarness(t, async () => modified);
  await h.create(WEBHOOK);
  assert.equal(h.start.mock.callCount(), NO_ROWS);
  const inbound = await h.create(POLL);
  assert.equal(h.start.mock.callCount(), ONE_CALL);
  assert.deepEqual(h.start.mock.calls[0]?.arguments, [inbound.id]);
});

test("a failed first request answers 422 platform_refused, inserts no row and starts no loop", async (t) => {
  const h = pollHarness(t, async () => ({
    ok: false,
    class: ResultClass.FinalRefusal,
    code: "repository.platform.github.final_refusal",
    status: UNAUTHORIZED_STATUS,
    message: "Bad credentials",
  }));
  const error = await refusesWith(
    h.create(POLL),
    CREDENTIAL_INVALID_STATUS,
    PLATFORM_REFUSED,
  );
  assert.deepEqual(error.details, { status: UNAUTHORIZED_STATUS });
  assert.equal(h.listEvents.mock.callCount(), ONE_CALL);
  assert.equal(h.rows().length, NO_ROWS);
  assert.equal(h.start.mock.callCount(), NO_ROWS);
  assert.deepEqual(h.drops, [POLL_CREDENTIAL]);
});

test("an unknown credential and a credential of another platform answer 422 with no platform call", async (t) => {
  const h = pollHarness(t, async () => modified);
  for (const credential of [UNKNOWN_CREDENTIAL, OTHER_PLATFORM_CREDENTIAL])
    await refusesWith(
      h.create({ ...POLL, credential }),
      CREDENTIAL_INVALID_STATUS,
      CREDENTIAL_INVALID,
    );
  assert.equal(h.listEvents.mock.callCount(), NO_ROWS);
  assert.equal(h.rows().length, NO_ROWS);
  assert.equal(h.drained(), NO_ROWS);
  assert.deepEqual(h.drops, []);
});

test("a credential archive between the first request and the insert refuses the insert and leaves no row", async (t) => {
  const credentials: { map?: Map<string, string> } = {};
  const h = pollHarness(t, async () => {
    credentials.map?.delete(POLL_CREDENTIAL);
    return modified;
  });
  credentials.map = h.credentials;
  await refusesWith(
    h.create(POLL),
    CREDENTIAL_INVALID_STATUS,
    CREDENTIAL_INVALID,
  );
  assert.equal(h.listEvents.mock.callCount(), ONE_CALL);
  assert.equal(h.rows().length, NO_ROWS);
  assert.equal(h.start.mock.callCount(), NO_ROWS);
  assert.deepEqual(h.drops, [POLL_CREDENTIAL]);
});

test("a failure after the release keeps the committed drain and drops the material", async (t) => {
  const failure = new Error("transport closed");
  const h = pollHarness(t, async () => {
    throw failure;
  });
  await assert.rejects(h.create(POLL), failure);
  assert.equal(h.drained(), ONE_ROW);
  assert.equal(h.rows().length, NO_ROWS);
  assert.deepEqual(h.drops, [POLL_CREDENTIAL]);
});
