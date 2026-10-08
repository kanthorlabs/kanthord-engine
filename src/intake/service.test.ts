import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { CodedError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { INTAKE_SERVICE_NAME } from "./contract.ts";
import { IntakeService } from "./index.ts";
import { unusedActionDependencies } from "./test-support.ts";

const STOPPED_CODE = "intake.lifecycle.stopped";

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
