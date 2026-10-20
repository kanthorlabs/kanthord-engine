import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  PROJECT_SERVICE_NAME,
  WorkerPlacement,
} from "./contract.ts";
import { projectMigrations } from "./migrations.ts";
import {
  BINDING_PLACEMENT_MISSING_CODE,
  enforceBindingPlacements,
} from "./placement-check.ts";
import { insertProject, writeBindingSet } from "./store.ts";

const PROJECT_NAME = "placement-check";
const HOSTED_WORKER = "coder@1";
const EXTERNAL_WORKER = "claude-code@1";
const isHostedWorker = (workerName: string) => workerName === HOSTED_WORKER;

function worker(name: string, placement?: WorkerPlacement) {
  return {
    kind: BindingKind.Worker,
    config: {
      worker: name,
      instance_count: 1,
      ...(placement === undefined ? {} : { placement }),
    },
  };
}

function plant(t: TestContext, bindings: Record<string, unknown>) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  ]);
  const projectId = store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    writeBindingSet(
      tx,
      project.id,
      BINDING_SET_INITIAL_VERSION,
      new Map(Object.entries(bindings)) as never,
    );
    return project.id;
  });
  return { store, projectId };
}

test("the placement check admits a hosted binding with a placement and an external binding with none", (t) => {
  const { store } = plant(t, {
    server: worker(HOSTED_WORKER, WorkerPlacement.Server),
    remote: worker(HOSTED_WORKER, WorkerPlacement.Worker),
    harness: worker(EXTERNAL_WORKER),
  });
  enforceBindingPlacements(store, isHostedWorker);
});

test("the placement check refuses a hosted binding with no placement and names the binding and the reset", (t) => {
  const { store, projectId } = plant(t, {
    server: worker(HOSTED_WORKER, WorkerPlacement.Server),
    bare: worker(HOSTED_WORKER),
  });
  assert.throws(
    () => enforceBindingPlacements(store, isHostedWorker),
    (error) => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, BINDING_PLACEMENT_MISSING_CODE);
      assert.deepEqual(error.fields, [
        ["path", store.path],
        ["project_id", projectId],
        ["binding", "bare"],
      ]);
      assert.match(error.message, /docs\/reference\/upgrade\.md/);
      assert.match(error.message, /delete kanthord\.db, tracking\.db/);
      return true;
    },
  );
});
