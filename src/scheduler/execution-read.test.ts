import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
  FIXTURE_DEADLINE,
} from "./test-support.ts";
import { insertExecution, readExecution } from "./execution-store.ts";
import { ClaimState } from "./contract.ts";

const NOT_OWNER = "scheduler.execution.not_owner";
const NOT_FOUND = "scheduler.execution.not_found";
const SINGLE_ITEM_COUNT = 1;
const TOTAL_ITEM_COUNT = 2;
const CURSOR_INVALID = "system.pagination.cursor_invalid";
function harness(t: TestContext) {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => insertExecution(tx, row));
  const machine = {
    clientId: createIdentity("client_identity"),
    name: "worker",
    projectId: row.project_id,
    resourceIdentity: row.resource_identity,
    issuedAt: FIXTURE_NOW,
  };
  const caller = {
    context: background,
    requestId: createIdentity("request"),
    identity: testMachineIdentity(machine, "machine", row.runtime_identity),
    commit: h.store.transaction.bind(h.store),
  };
  return { ...h, row, machine, caller };
}

test("claim get reports running, finished and lost without modifying the row", async (t) => {
  const h = harness(t);
  let now = FIXTURE_NOW;
  t.mock.method(Date, "now", () => now);
  const read = () =>
    h.invoke(
      "claimGet",
      { params: { execution_id: h.row.execution_id }, query: {}, body: null },
      h.caller,
    );
  assert.equal((await read()).claim_state, ClaimState.Running);
  now = FIXTURE_DEADLINE;
  assert.equal((await read()).claim_state, ClaimState.Lost);
  assert.deepEqual(
    h.store.transaction((tx) => readExecution(tx, h.row.execution_id)),
    h.row,
  );
  h.store.transaction((tx) => h.service.revoke(tx, h.row.node_id, FIXTURE_NOW));
  assert.equal((await read()).claim_state, ClaimState.Finished);
  assert.deepEqual(
    h.calls.filter((call) => call.method !== ATTRIBUTION),
    [],
  );
});
const ATTRIBUTION = "clientAttributionOf";

test("human execution reads paginate all states and isolate project, node and attempt filters", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const ended = executionFixture({
    project_id: h.row.project_id,
    node_id: h.row.node_id,
    attempt: 2,
    ended_at: FIXTURE_NOW,
  });
  h.store.transaction((tx) => insertExecution(tx, ended));
  const list = (query = {}) =>
    h.invoke(
      "executionList",
      { params: { project_id: h.row.project_id }, query, body: null },
      h.caller,
    );
  const all = await list();
  assert.deepEqual(
    all.items.map((item) => item.execution_id),
    [ended.execution_id, h.row.execution_id].sort().reverse(),
  );
  assert.equal(all.items.length, TOTAL_ITEM_COUNT);
  const first = await list({ limit: 1 });
  assert.equal(first.items.length, SINGLE_ITEM_COUNT);
  const second = await list({ limit: 1, cursor: first.next_cursor });
  assert.deepEqual([...first.items, ...second.items], all.items);
  assert.equal(second.next_cursor, null);
  assert.deepEqual((await list({ node_id: h.row.node_id })).items, all.items);
  assert.deepEqual(
    (await list({ node_id: h.row.node_id, attempt: 2 })).items.map(
      (item) => item.execution_id,
    ),
    [ended.execution_id],
  );
  assert.deepEqual(
    (await list({ node_id: h.row.node_id, attempt: 3 })).items,
    [],
  );
  assert.deepEqual((await list({ node_id: createIdentity("node") })).items, []);
  await assert.rejects(list({ attempt: 1 }));
  for (const cursor of [
    "malformed",
    Buffer.from(createIdentity("job")).toString("base64url"),
  ])
    await assert.rejects(list({ cursor }), { code: CURSOR_INVALID });
  const get = (executionId: string) =>
    h.invoke(
      "executionGet",
      { params: { execution_id: executionId }, query: {}, body: null },
      h.caller,
    );
  assert.equal(
    (await get(ended.execution_id)).claim_state,
    ClaimState.Finished,
  );
  await assert.rejects(get(createIdentity("execution")), { code: NOT_FOUND });
  const foreign = executionFixture();
  h.store.transaction((tx) => insertExecution(tx, foreign));
  assert.deepEqual((await list({ node_id: foreign.node_id })).items, []);
});

test("claim get isolates runtime, binding and project and distinguishes absent executions", async (t) => {
  const h = harness(t);
  const input = {
    params: { execution_id: h.row.execution_id },
    query: {},
    body: null,
  };
  const identities = [
    testMachineIdentity(h.machine, "other", createIdentity("worker_instance")),
    testMachineIdentity(
      { ...h.machine, resourceIdentity: "other" },
      "other",
      h.row.runtime_identity,
    ),
    testMachineIdentity(
      { ...h.machine, projectId: createIdentity("project") },
      "other",
      h.row.runtime_identity,
    ),
  ];
  for (const identity of identities)
    await assert.rejects(
      h.invoke("claimGet", input, { ...h.caller, identity }),
      { code: NOT_OWNER },
    );
  await assert.rejects(
    h.invoke(
      "claimGet",
      { ...input, params: { execution_id: createIdentity("execution") } },
      h.caller,
    ),
    { code: NOT_FOUND },
  );
  assert.deepEqual(
    h.store.transaction((tx) => readExecution(tx, h.row.execution_id)),
    h.row,
  );
});
