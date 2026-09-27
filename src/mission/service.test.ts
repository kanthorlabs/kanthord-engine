import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import {
  MISSION_SERVICE_NAME,
  type MissionBindings,
  type WorkQueue,
} from "./contract.ts";
import { MissionService } from "./service.ts";

const UNEXPECTED_COLLABORATION = "unexpected collaboration call";
const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const CONSECUTIVE_LOSS_LIMIT = 3;
const TEXT_MAX_BYTES = 32768;

const bindings: MissionBindings = {
  resolveBinding() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  getBindingRevision() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
};
const workQueue: WorkQueue = {
  insert() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  delete() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  priorityUpdate() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
};

function makeService(health: HealthRegistry): MissionService {
  return new MissionService({
    config: {
      consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
      textMaxBytes: TEXT_MAX_BYTES,
    },
    health,
    bindings,
    workQueue,
  });
}

test("MissionService healthcheck follows lifecycle", async () => {
  const health = new HealthRegistry();
  const mission = makeService(health);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Unavailable,
  });
  assert.equal(await mission.start(), null);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Healthy,
  });
  assert.equal(await mission.stop(), null);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Unavailable,
  });
});

test("MissionService registers its operations health probe", async () => {
  const registry = new HealthRegistry();
  const mission = makeService(registry);
  assert.equal(await mission.start(), null);
  const results = await registry.check(background);
  assert.ok(Object.hasOwn(results, MISSION_SERVICE_NAME));
  assert.equal(results[MISSION_SERVICE_NAME]?.operations, HealthStatus.Healthy);
  assert.equal(await mission.stop(), null);
});

test("MissionService refuses to restart after stop", async () => {
  const mission = makeService(new HealthRegistry());
  assert.equal(await mission.start(), null);
  assert.equal(await mission.stop(), null);
  const error = await mission.start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISSION_STOPPED_CODE);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Unavailable,
  });
});
