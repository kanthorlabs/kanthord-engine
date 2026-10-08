import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { CodedError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundKind,
  InboundPlatform,
  type InboundKindValue,
} from "./contract.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";

const STOPPED_CODE = "intake.lifecycle.stopped";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL = "github-poll";
const OTHER_CREDENTIAL = "github-other";
const CREATED_AT = 1000;
const NO_CALLS = 0;

function identity(service: string): ServiceIdentity {
  return { kind: IdentityKind.Service, service };
}

function fixture(t: TestContext, service = INTAKE_SERVICE_NAME) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  const health = new HealthRegistry();
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health,
    identity: identity(service),
    ...unusedActionDependencies(),
  });
  return { intake, health, store };
}

test("Intake runs each lifecycle phase once and refuses a restart", async (t) => {
  const { intake } = fixture(t);
  const running = intake.run();
  assert.equal(await intake.quiesce(), null);
  await intake.drain();
  assert.equal(await intake.stop(), null);
  assert.equal(await running, null);
  const restart = await intake.start();
  assert.ok(restart instanceof CodedError);
  assert.equal(restart.code, STOPPED_CODE);
});

test("Intake start refuses the identity of another service", async (t) => {
  const { intake } = fixture(t, "mission");
  await assert.rejects(intake.start(), assert.AssertionError);
});

test("Intake probe answers 200 while running and 503 after stop", async (t) => {
  const { intake, health } = fixture(t);
  assert.deepEqual(await intake.healthcheck(), {
    events: HealthStatus.Unavailable,
  });
  assert.equal(await intake.start(), null);
  assert.deepEqual(await health.check(), {
    intake: { events: HealthStatus.Healthy },
  });
  assert.equal(await intake.stop(), null);
  assert.deepEqual(await health.check(), {
    intake: { events: HealthStatus.Unavailable },
  });
});

test("Intake answers no resource inventory entry", (t) => {
  const { intake, store } = fixture(t);
  assert.deepEqual(
    store.transaction((tx) => intake.resourceInventory(tx)),
    [],
  );
});

function insertNaming(
  store: Store,
  kind: InboundKindValue,
  credential: string | null,
): string {
  const id = allocateInboundId();
  store.transaction((tx) =>
    insertInbound(tx, id, {
      project_id: PROJECT_ID,
      kind,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential,
      configuration: { resource: "acme/app" },
      checkpoint: null,
      created_at: CREATED_AT,
    }),
  );
  return id;
}

function migratedFixture(t: TestContext) {
  const h = fixture(t);
  h.store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  return h;
}

test("inboundsNaming answers each inbound that names the credential", (t) => {
  const { intake, store } = migratedFixture(t);
  const first = insertNaming(store, InboundKind.Poll, CREDENTIAL);
  const second = insertNaming(store, InboundKind.Poll, CREDENTIAL);
  insertNaming(store, InboundKind.Poll, OTHER_CREDENTIAL);
  assert.deepEqual(
    store.transaction((tx) => intake.inboundsNaming(tx, CREDENTIAL)),
    [first, second].sort().map((inbound_id) => ({ inbound_id })),
  );
});

test("inboundsNaming answers no webhook inbound, which names no credential", (t) => {
  const { intake, store } = migratedFixture(t);
  insertNaming(store, InboundKind.Webhook, null);
  assert.deepEqual(
    store.transaction((tx) => intake.inboundsNaming(tx, CREDENTIAL)),
    [],
  );
});

test("inboundsNaming opens no transaction", (t) => {
  const { intake, store } = migratedFixture(t);
  const id = insertNaming(store, InboundKind.Poll, CREDENTIAL);
  store.transaction((tx) => {
    const transactions = t.mock.method(store, "transaction");
    assert.deepEqual(intake.inboundsNaming(tx, CREDENTIAL), [
      { inbound_id: id },
    ]);
    assert.equal(transactions.mock.callCount(), NO_CALLS);
  });
});
