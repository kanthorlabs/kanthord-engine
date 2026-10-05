import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  NodeKind,
  RepositoryAction,
  MissionErrorCode,
  AssessmentResult,
  ActorKind,
} from "./contract.ts";
import { ControlError } from "./control.ts";
import { closeAttempt, openAttempt } from "./record-store.ts";
import {
  insertAssessment,
  insertOutcome,
  insertEvidence,
} from "./record-store.ts";
import { writeHumanRecords } from "./control.ts";
import { controlHarness } from "./test-support.ts";
import { encode } from "./node-read.ts";
import { readCurrentRevision, insertRevision } from "./store.ts";
import { revisionFromRow } from "./revision.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST = 1;
const SECOND = 2;
const NOW = 100;
const NOT_FOUND = "mission.record.not_found";
const KEY = "repo.pull_request";
const ZERO = 0;
const MANY_ATTEMPTS = 70;

test("action pages cross actionless batches and never derive attempts newer than the cursor", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const inactiveId = createIdentity("binding");
  let derivations = ZERO;
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    bindingId: id,
    projectId: h.projectId,
    name: "repo",
    resourceIdentity: "repository:github:owner/repo",
    revision: FIRST,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = (_tx, id) => {
    derivations++;
    return {
      bindingId: id,
      projectId: h.projectId,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      platform: "github",
      sshCredential: "github-ssh",
      credential: "github",
      baseBranch: "main",
      action: id === bindingId ? RepositoryAction.PullRequest : null,
      projectPrompt: null,
    };
  };
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(NodeKind.Objective, h.nodeId);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([bindingId]), h.nodeId);
    const prior = revisionFromRow(tx, readCurrentRevision(tx, h.nodeId)!);
    insertRevision(tx, {
      ...prior,
      revision: SECOND,
      content: { ...prior.content, bindings: [inactiveId] },
    });
    for (let number = FIRST; number <= MANY_ATTEMPTS; number++) {
      openAttempt(
        tx,
        h.nodeId,
        number === FIRST ? FIRST : SECOND,
        h.actor,
        NOW,
      );
      closeAttempt(tx, h.nodeId, number, NOW);
    }
  });
  const input = {
    params: { nodeId: h.nodeId },
    query: { limit: FIRST },
    body: null,
  };
  const page = await h.invoke("externalAction.list", input);
  assert.deepEqual(
    page.items.map((item) => item.attempt),
    [FIRST],
  );
  assert.equal(page.nextCursor, null);
  assert.equal(derivations, MANY_ATTEMPTS);
  derivations = ZERO;
  const older = await h.invoke("externalAction.list", {
    ...input,
    query: { limit: FIRST, cursor: encode(`${SECOND}|${KEY}`) },
  });
  assert.deepEqual(older.items, page.items);
  assert.equal(derivations, SECOND);
});

test("assessment and outcome reads filter attempt zero, evaluate currency, union evidence and paginate identities", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const node = h.node();
  h.dependencies.executionAttribution.of = () => ({
    clientId: createIdentity("client_identity"),
    name: "Runtime",
    workerName: "reviewer@1",
  });
  const records = h.store.transaction((tx) => {
    const human = writeHumanRecords(
      tx,
      node,
      AssessmentResult.Undetermined,
      "Hold",
      h.actor,
      [],
      NOW,
    );
    openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
    const evidenceIds = [
      createIdentity("evidence"),
      createIdentity("evidence"),
      createIdentity("evidence"),
    ];
    for (const id of evidenceIds)
      insertEvidence(
        tx,
        {
          id,
          node_id: h.nodeId,
          attempt: FIRST,
          subject: "Work",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: JSON.stringify(h.actor),
          created_at: NOW,
        },
        [],
      );
    const assessment = insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.nodeId,
      attempt: FIRST,
      node_revision: FIRST,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: JSON.stringify(evidenceIds.slice(ZERO, SECOND)),
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: createIdentity("execution"),
      actor: null,
      created_at: NOW,
    });
    const outcome = insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.nodeId,
      result: AssessmentResult.Success,
      assessment_id: assessment.id,
      evidence_ids: JSON.stringify(evidenceIds.slice(FIRST)),
      created_at: NOW,
    });
    return { human, assessment, outcome, evidenceIds };
  });
  const base = { params: { nodeId: h.nodeId }, query: {}, body: null };
  const human = await h.invoke("assessment.list", {
    ...base,
    query: { attempt: ZERO },
  });
  assert.equal(human.items.length, FIRST);
  assert.equal(human.items[ZERO]?.actor.kind, ActorKind.Human);
  assert.equal(human.items[ZERO]?.currency, null);
  assert.equal(human.items[ZERO]?.testedInput, null);
  assert.equal(human.items[ZERO]?.workerVersion, null);
  const execution = await h.invoke("assessment.get", {
    params: { assessmentId: records.assessment.id },
    query: {},
    body: null,
  });
  assert.equal(execution.actor.kind, ActorKind.Execution);
  assert.equal(execution.currency?.current, true);
  const outcome = await h.invoke("outcome.get", {
    params: { outcomeId: records.outcome.id },
    query: {},
    body: null,
  });
  assert.deepEqual(outcome.evidenceIds, records.evidenceIds.sort());
  const outcomePage = await h.invoke("outcome.list", {
    ...base,
    query: { attempt: FIRST },
  });
  assert.deepEqual(
    outcomePage.items[ZERO]!.evidenceIds,
    records.evidenceIds.sort(),
  );
  for (const operation of ["assessment.list", "outcome.list"] as const) {
    const page = await h.invoke(operation, {
      ...base,
      query: { limit: FIRST },
    });
    const next = await h.invoke(operation, {
      ...base,
      query: { cursor: page.nextCursor! },
    });
    assert.ok(page.items[ZERO]!.id > next.items[ZERO]!.id);
    assert.equal(next.nextCursor, null);
    assert.equal(
      (await h.invoke(operation, { ...base, query: { attempt: FIRST } })).items
        .length,
      FIRST,
    );
    assert.equal(
      (await h.invoke(operation, { ...base, query: { attempt: ZERO } })).items
        .length,
      FIRST,
    );
  }
});

test("attempt and external-action reads page in descending order and filter attempt zero", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = () => ({
    projectId: h.projectId,
    bindingId,
    name: "repo",
    resourceIdentity: "repository:github:owner/repo",
    revision: FIRST,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    projectId: h.projectId,
    bindingId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    sshCredential: "github-ssh",
    credential: "github",
    baseBranch: "main",
    action: RepositoryAction.PullRequest,
    projectPrompt: null,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(NodeKind.Objective, h.nodeId);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([bindingId]), h.nodeId);
    openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
    closeAttempt(tx, h.nodeId, FIRST, NOW);
    openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
  });
  const input = {
    params: { nodeId: h.nodeId },
    query: { limit: FIRST },
    body: null,
  };
  const first = await h.invoke("attempt.list", input);
  assert.deepEqual(
    first.items.map((item) => item.attempt),
    [SECOND],
  );
  const next = await h.invoke("attempt.list", {
    ...input,
    query: { cursor: first.nextCursor! },
  });
  assert.deepEqual(
    next.items.map((item) => item.attempt),
    [FIRST],
  );
  assert.equal(next.nextCursor, null);
  const actions = await h.invoke("externalAction.list", input);
  assert.deepEqual(
    actions.items.map((item) => item.attempt),
    [SECOND],
  );
  const older = await h.invoke("externalAction.list", {
    ...input,
    query: { cursor: actions.nextCursor! },
  });
  assert.deepEqual(
    older.items.map((item) => item.attempt),
    [FIRST],
  );
  const empty = await h.invoke("externalAction.list", {
    ...input,
    query: { attempt: 0 },
  });
  assert.deepEqual(empty, { items: [], nextCursor: null });
  const filtered = await h.invoke("externalAction.list", {
    ...input,
    query: { attempt: FIRST },
  });
  assert.deepEqual(
    filtered.items.map((item) => item.attempt),
    [FIRST],
  );
  assert.deepEqual(
    await h.invoke("externalAction.list", {
      ...input,
      query: { attempt: SECOND + FIRST },
    }),
    { items: [], nextCursor: null },
  );
  const get = await h.invoke("externalAction.get", {
    params: { nodeId: h.nodeId, attempt: SECOND, actionKey: KEY },
    query: {},
    body: null,
  });
  assert.equal(get.action.bindingId, bindingId);
  await assert.rejects(
    h.invoke("externalAction.get", {
      params: {
        nodeId: h.nodeId,
        attempt: SECOND,
        actionKey: "other.pull_request",
      },
      query: {},
      body: null,
    }),
    (error) => error instanceof OperationError && error.code === NOT_FOUND,
  );
});

test("record reads refuse absent attempts, malformed cursors and task nodes", async (t) => {
  const h = controlHarness(t, IDENTITY);
  await assert.rejects(
    h.invoke("attempt.get", {
      params: { nodeId: h.nodeId, attempt: FIRST },
      query: {},
      body: null,
    }),
    (error) => error instanceof OperationError && error.code === NOT_FOUND,
  );
  for (const operation of ["attempt.list", "externalAction.list"] as const) {
    await assert.rejects(
      h.invoke(operation, {
        params: { nodeId: h.nodeId },
        query: { cursor: "invalid" },
        body: null,
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.CursorInvalid,
    );
  }
  h.store.database
    .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
    .run(NodeKind.Task, h.nodeId);
  await assert.rejects(
    h.invoke("attempt.list", {
      params: { nodeId: h.nodeId },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Task,
  );
});
