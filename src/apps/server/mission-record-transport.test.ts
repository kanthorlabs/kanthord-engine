import assert from "node:assert/strict";
import { test } from "node:test";
import { directClient } from "../../gateway/index.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { createIdentity } from "../../kernel/identity.ts";
import {
  ActorKind,
  NodeKind,
  NodeState,
  missionOperations,
} from "../../mission/contract.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_WORKER_BINDING,
  TEST_PROJECT_ID,
} from "./test-support.ts";

const UNAUTHORIZED = "gateway.authentication.unauthorized";
const INVALID = "gateway.request.validation_failed";
const NOT_FOUND = "mission.record.not_found";
const NODE_NOT_FOUND = "mission.node.not_found";
const TASK = "mission.node.control_task";
const CURSOR = "system.pagination.cursor_invalid";
const FIRST_ATTEMPT = 1;
const INITIAL_ATTEMPT = 0;
const INITIAL_PRIORITY = 0;
const NOW = 100;
const ASSESSMENT_GET = "assessment.get";
const OUTCOME_GET = "outcome.get";
const ACTION_GET = "externalAction.get";
const READS = [
  "attempt.list",
  "attempt.get",
  "externalAction.list",
  "externalAction.get",
  "assessment.list",
  "assessment.get",
  "outcome.list",
  "outcome.get",
] as const;
const FILTERED = [
  "externalAction.list",
  "assessment.list",
  "outcome.list",
] as const;

test("all record reads enforce human access with valid parameters and return precise HTTP refusals", async (t) => {
  const h = await gatewayFixture(t, { machines: fakeMachines() });
  const params = {
    node_id: createIdentity("node"),
    assessment_id: createIdentity("assessment"),
    outcome_id: createIdentity("outcome"),
    attempt: String(FIRST_ATTEMPT),
    action_key: "repo.pull_request",
  };
  const machine = await h.machineToken(TEST_PROJECT_ID, TEST_WORKER_BINDING);
  const pathOf = (name: (typeof READS)[number]) =>
    missionOperations[name].path.replace(
      /:([^/]+)/g,
      (_match, key: keyof typeof params) => params[key],
    );
  const refuses = async (
    path: string,
    status: number,
    code: string,
    token: string | null = h.token,
  ) => {
    const response = await h.request(path, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, status);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      code,
    );
  };
  for (const name of READS) {
    await refuses(pathOf(name), HttpStatus.Unauthorized, UNAUTHORIZED, null);
    await refuses(pathOf(name), HttpStatus.Unauthorized, UNAUTHORIZED, machine);
    await refuses(
      pathOf(name),
      HttpStatus.NotFound,
      name === ASSESSMENT_GET || name === OUTCOME_GET
        ? NOT_FOUND
        : NODE_NOT_FOUND,
    );
  }
  h.store.transaction((tx) => {
    const projectId = createIdentity("project");
    h.mission.createMission(tx, projectId, {
      kind: ActorKind.Human,
      account: "ulrich",
      name: "Ulrich",
    });
    const missionId = (
      tx.database
        .prepare("SELECT id FROM mission_mission WHERE project_id = ?")
        .get(projectId) as { id: string }
    ).id;
    tx.database
      .prepare(
        "INSERT INTO mission_node (id, mission_id, kind, filename, parent_id, state, attempt, priority, retired_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)",
      )
      .run(
        params.node_id,
        missionId,
        NodeKind.Objective,
        "objective.md",
        NodeState.Available,
        INITIAL_ATTEMPT,
        INITIAL_PRIORITY,
        NOW,
      );
    const taskId = createIdentity("node");
    tx.database
      .prepare(
        "INSERT INTO mission_node (id, mission_id, kind, filename, parent_id, state, attempt, priority, retired_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)",
      )
      .run(taskId, missionId, NodeKind.Task, "task.md", params.node_id, NOW);
    params.node_id = taskId;
  });
  for (const name of [
    "attempt.list",
    "attempt.get",
    "externalAction.list",
    "externalAction.get",
    "assessment.list",
    "outcome.list",
  ] as const)
    await refuses(pathOf(name), HttpStatus.BadRequest, TASK);
  h.store.database
    .prepare(
      "UPDATE mission_node SET kind = ?, state = ?, attempt = ?, priority = ? WHERE id = ?",
    )
    .run(
      NodeKind.Initiative,
      NodeState.Available,
      INITIAL_ATTEMPT,
      INITIAL_PRIORITY,
      params.node_id,
    );
  for (const name of [
    "attempt.list",
    "externalAction.list",
    "assessment.list",
    "outcome.list",
  ] as const)
    await refuses(`${pathOf(name)}?cursor=bad`, HttpStatus.BadRequest, CURSOR);
  await refuses(pathOf("attempt.get"), HttpStatus.NotFound, NOT_FOUND);
  await refuses(pathOf("externalAction.get"), HttpStatus.NotFound, NOT_FOUND);
  const identity = await h.gateway.authentication.authenticate(
    `Bearer ${h.token}`,
  );
  for (const name of FILTERED) {
    for (const value of ["", " ", "false", "0x1", "1e0", "1.5"])
      await refuses(
        `${pathOf(name)}?attempt=${encodeURIComponent(value)}`,
        HttpStatus.BadRequest,
        INVALID,
      );
    const api = directClient(
      { read: missionOperations[name] },
      h.gateway.invocation,
    );
    for (const attempt of [null, false, true, "", " ", [], {}]) {
      const result = await api.read(
        { params: { node_id: params.node_id }, query: { attempt }, body: null },
        { identity },
      );
      assert.equal(result.type, OperationResultType.Failure);
      assert.ok(result.type === OperationResultType.Failure);
      assert.equal(result.status, HttpStatus.BadRequest);
      assert.equal(result.error.error.code, INVALID);
    }
    const explicitZero = await h.request(`${pathOf(name)}?attempt=0`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    assert.equal(explicitZero.status, HttpStatus.OK);
    assert.deepEqual(await explicitZero.json(), {
      items: [],
      next_cursor: null,
    });
  }
  for (const name of ["attempt.get", "externalAction.get"] as const) {
    const api = directClient(
      { read: missionOperations[name] },
      h.gateway.invocation,
    );
    for (const attempt of [true, null, " ", "1e0"]) {
      const result = await api.read(
        {
          params: {
            node_id: params.node_id,
            attempt,
            ...(name === ACTION_GET ? { action_key: params.action_key } : {}),
          },
          query: {},
          body: null,
        },
        { identity },
      );
      assert.ok(result.type === OperationResultType.Failure);
      assert.equal(result.error.error.code, INVALID);
    }
  }
});
