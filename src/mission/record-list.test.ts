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
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const NOW = 100;
const NOT_FOUND = "mission.record.not_found";
const KEY = "repo.pull_request";
const NO_ATTEMPT = 0;
const FIRST_INDEX = 0;
const MANY_ATTEMPTS = 70;

test("action pages cross actionless batches and never derive attempts newer than the cursor", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const inactiveId = createIdentity("binding");
  let derivations = NO_ATTEMPT;
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    bindingId: id,
    projectId: h.projectId,
    name: "repo",
    resourceIdentity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
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
      revision: SECOND_ATTEMPT,
      content: { ...prior.content, bindings: [inactiveId] },
    });
    for (let number = FIRST_ATTEMPT; number <= MANY_ATTEMPTS; number++) {
      openAttempt(
        tx,
        h.nodeId,
        number === FIRST_ATTEMPT ? FIRST_ATTEMPT : SECOND_ATTEMPT,
        h.actor,
        NOW,
      );
      closeAttempt(tx, h.nodeId, number, NOW);
    }
  });
  const input = {
    params: { nodeId: h.nodeId },
    query: { limit: FIRST_ATTEMPT },
    body: null,
  };
  const page = await h.invoke("externalAction.list", input);
  assert.deepEqual(
    page.items.map((item) => item.attempt),
    [FIRST_ATTEMPT],
  );
  assert.equal(page.next_cursor, null);
  assert.equal(derivations, MANY_ATTEMPTS);
  derivations = NO_ATTEMPT;
  const older = await h.invoke("externalAction.list", {
    ...input,
    query: { limit: FIRST_ATTEMPT, cursor: encode(`${SECOND_ATTEMPT}|${KEY}`) },
  });
  assert.deepEqual(older.items, page.items);
  assert.equal(derivations, SECOND_ATTEMPT);
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
    openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW);
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
          attempt: FIRST_ATTEMPT,
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
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: JSON.stringify(
        evidenceIds.slice(FIRST_INDEX, SECOND_ATTEMPT),
      ),
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
      evidence_ids: JSON.stringify(evidenceIds.slice(FIRST_ATTEMPT)),
      created_at: NOW,
    });
    return { human, assessment, outcome, evidenceIds };
  });
  const base = { params: { nodeId: h.nodeId }, query: {}, body: null };
  const human = await h.invoke("assessment.list", {
    ...base,
    query: { attempt: NO_ATTEMPT },
  });
  assert.equal(human.items.length, FIRST_ATTEMPT);
  assert.equal(human.items[FIRST_INDEX]?.actor.kind, ActorKind.Human);
  assert.equal(human.items[FIRST_INDEX]?.currency, null);
  assert.equal(human.items[FIRST_INDEX]?.testedInput, null);
  assert.equal(human.items[FIRST_INDEX]?.workerVersion, null);
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
    query: { attempt: FIRST_ATTEMPT },
  });
  assert.deepEqual(
    outcomePage.items[FIRST_INDEX]!.evidenceIds,
    records.evidenceIds.sort(),
  );
  for (const operation of ["assessment.list", "outcome.list"] as const) {
    const page = await h.invoke(operation, {
      ...base,
      query: { limit: FIRST_ATTEMPT },
    });
    const next = await h.invoke(operation, {
      ...base,
      query: { cursor: page.next_cursor! },
    });
    assert.ok(page.items[FIRST_INDEX]!.id > next.items[FIRST_INDEX]!.id);
    assert.equal(next.next_cursor, null);
    assert.equal(
      (
        await h.invoke(operation, {
          ...base,
          query: { attempt: FIRST_ATTEMPT },
        })
      ).items.length,
      FIRST_ATTEMPT,
    );
    assert.equal(
      (await h.invoke(operation, { ...base, query: { attempt: NO_ATTEMPT } }))
        .items.length,
      FIRST_ATTEMPT,
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
    revision: FIRST_ATTEMPT,
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
    openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW);
    closeAttempt(tx, h.nodeId, FIRST_ATTEMPT, NOW);
    openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW);
  });
  const input = {
    params: { nodeId: h.nodeId },
    query: { limit: FIRST_ATTEMPT },
    body: null,
  };
  const first = await h.invoke("attempt.list", input);
  assert.deepEqual(
    first.items.map((item) => item.attempt),
    [SECOND_ATTEMPT],
  );
  const next = await h.invoke("attempt.list", {
    ...input,
    query: { cursor: first.next_cursor! },
  });
  assert.deepEqual(
    next.items.map((item) => item.attempt),
    [FIRST_ATTEMPT],
  );
  assert.equal(next.next_cursor, null);
  const actions = await h.invoke("externalAction.list", input);
  assert.deepEqual(
    actions.items.map((item) => item.attempt),
    [SECOND_ATTEMPT],
  );
  const older = await h.invoke("externalAction.list", {
    ...input,
    query: { cursor: actions.next_cursor! },
  });
  assert.deepEqual(
    older.items.map((item) => item.attempt),
    [FIRST_ATTEMPT],
  );
  const empty = await h.invoke("externalAction.list", {
    ...input,
    query: { attempt: 0 },
  });
  assert.deepEqual(empty, { items: [], next_cursor: null });
  const filtered = await h.invoke("externalAction.list", {
    ...input,
    query: { attempt: FIRST_ATTEMPT },
  });
  assert.deepEqual(
    filtered.items.map((item) => item.attempt),
    [FIRST_ATTEMPT],
  );
  assert.deepEqual(
    await h.invoke("externalAction.list", {
      ...input,
      query: { attempt: SECOND_ATTEMPT + FIRST_ATTEMPT },
    }),
    { items: [], next_cursor: null },
  );
  const get = await h.invoke("externalAction.get", {
    params: { nodeId: h.nodeId, attempt: SECOND_ATTEMPT, actionKey: KEY },
    query: {},
    body: null,
  });
  assert.equal(get.action.bindingId, bindingId);
  await assert.rejects(
    h.invoke("externalAction.get", {
      params: {
        nodeId: h.nodeId,
        attempt: SECOND_ATTEMPT,
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
      params: { nodeId: h.nodeId, attempt: FIRST_ATTEMPT },
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
