import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ZodError } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { CommitType } from "../kernel/commit-message.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import {
  ActorKind,
  AssessmentResult,
  Intent,
  MissionErrorCode,
  NodeState,
  PROPOSAL_IDENTITY_PREFIX,
  RevisionWrite,
  type TaskContent,
} from "./contract.ts";
import {
  LINK_RESOURCE,
  linkOf,
  linkUpdateHarness,
  TRUSTED_ACTOR,
} from "./link-update-test-support.ts";
import { linkUpdatesOf } from "./link-update-read.ts";
import { insertProposal } from "./proposal-store.ts";
import { closeAttempt, insertAssessment, openAttempt } from "./record-store.ts";
import { revisionFromRow } from "./revision.ts";
import {
  insertNode,
  insertRevision,
  readCurrentRevision,
  readDependsOnIds,
  readNode,
  setNodeState,
} from "./store.ts";
import { actCalls } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "jti_ulrich");
const REPOSITORY_RESOURCE = "repository:github:acme/app";
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const LAST_ATTEMPT = 2;
const NO_ATTEMPT = 0;
const NODE_TIME = 100;
const NO_ROWS = 0;
const NO_ACTS = 0;
const SINGLE = 1;
const LINK_ROW_COUNT = 2;
const FIRST_OCCURRED_AT = 1700000001000;
const SECOND_OCCURRED_AT = 1700000002000;
const STALE_VERSION = 99;
const SUFFIX_START = PROPOSAL_IDENTITY_PREFIX.length + 1;
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const NEW_REQUIREMENT = "New requirement";
const NEW_CRITERION = "New criterion";
const ORIGIN_NAME = "Origin";
const TAGS = ["platform.linux"];
const TASK_FILENAMES = ["task-one.md", "task-two.md"];

function taskOf(filename: string): TaskContent {
  return {
    id: createIdentity("task"),
    filename,
    content: {
      name: `Task ${filename}`,
      requirement: "Change the code",
      criterion: "The test passes",
      verifications: ["pnpm test"],
      bindings: [],
    },
  };
}

function fixture(t: TestContext, state: NodeState) {
  const h = linkUpdateHarness(t, IDENTITY);
  const repositoryId = h.addBinding(REPOSITORY_RESOURCE, undefined);
  const conversationId = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR]);
  const resources = new Map([
    [repositoryId, REPOSITORY_RESOURCE],
    [conversationId, LINK_RESOURCE],
  ]);
  h.dependencies.bindings.resolveBindingIdentity = (_tx, projectId, id) => {
    const resource = resources.get(id);
    return projectId === h.project_id && resource !== undefined
      ? { binding_id: id, resource_identity: resource }
      : null;
  };
  const nodeId = createIdentity("node");
  const tasks = TASK_FILENAMES.map(taskOf);
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: nodeId,
      mission_id: h.mission_id,
      filename: "origin.md",
      created_at: NODE_TIME,
    });
    insertRevision(tx, {
      node_id: nodeId,
      revision: FIRST_REVISION,
      filename: "origin.md",
      reason: "plan",
      actor: ACTOR,
      created_at: NODE_TIME,
      content: {
        name: ORIGIN_NAME,
        requirement: "Origin requirement",
        criterion: "Origin criterion",
        verifications: ["true", "pnpm test"],
        bindings: [repositoryId, conversationId],
        intent: Intent.Implement,
        tags: TAGS,
        external_links: [linkOf()],
        commit_type: CommitType.Fix,
      },
      tasks,
      change: {
        write: RevisionWrite.NodeCreate,
        previous_revision: null,
        changed_fields: [],
      },
      pinned_by_attempts: [],
    });
    for (let attempt = FIRST_ATTEMPT; attempt <= LAST_ATTEMPT; attempt++) {
      openAttempt(tx, nodeId, FIRST_REVISION, ACTOR, NODE_TIME);
      closeAttempt(tx, nodeId, attempt, NODE_TIME);
    }
    setNodeState(tx, nodeId, state);
  });
  const openProposal = (
    target = nodeId,
    id = createIdentity(PROPOSAL_IDENTITY_PREFIX),
  ) => {
    h.store.transaction((tx) =>
      insertProposal(tx, {
        id,
        node_id: target,
        attempt: LAST_ATTEMPT,
        assessment_id: null,
        content: JSON.stringify({ node_revision: FIRST_REVISION }),
        created_node_id: null,
        approved_at: null,
        rejected_at: null,
        created_at: NODE_TIME,
      }),
    );
    return id;
  };
  const version = () => h.store.transaction((tx) => readVersion(tx));
  const decide = (
    body: Record<string, unknown>,
    target = nodeId,
    expected = version(),
  ) =>
    h.invoke("followup.decide", {
      params: { node_id: target },
      query: {},
      body: { expected_mission_version: expected, ...body },
    });
  const list = (projectId = h.project_id, query: object = {}) =>
    h.invoke("followup.list", {
      params: { project_id: projectId },
      query,
      body: null,
    });
  const revisionOf = (id: string) =>
    h.store.transaction((tx) =>
      revisionFromRow(tx, readCurrentRevision(tx, id)!),
    );
  const dependsOn = (id: string) =>
    h.store.transaction((tx) => readDependsOnIds(tx, id));
  const stateOf = (id: string) =>
    h.store.transaction((tx) => readNode(tx, id)!.state);
  return {
    ...h,
    nodeId,
    tasks,
    repositoryId,
    conversationId,
    openProposal,
    decide,
    list,
    revisionOf,
    dependsOn,
    stateOf,
    version,
  };
}

function readVersion(tx: Transaction): number {
  const row = tx.database
    .prepare("SELECT version FROM mission_mission LIMIT 1")
    .get() as { version: number };
  return row.version;
}

function refusedWith(code: string, details?: unknown) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  };
}

function suffixOf(proposalId: string): string {
  return proposalId.slice(SUFFIX_START).toLowerCase();
}

test("an approval of the proposal of a Completed node creates a node with the copied revision and a dependency on it", async (t) => {
  const h = fixture(t, NodeState.Completed);
  const proposalId = h.openProposal();
  const result = await h.decide({ approve: true });
  const createdId = result.created_node_id;
  assert.ok(createdId);
  const created = h.revisionOf(createdId);
  const origin = h.revisionOf(h.nodeId);
  assert.deepEqual(created.content, origin.content);
  assert.equal(created.content.intent, Intent.Implement);
  assert.deepEqual(created.content.bindings, [
    h.repositoryId,
    h.conversationId,
  ]);
  assert.deepEqual(created.content.external_links, [linkOf()]);
  assert.equal(created.content.commit_type, CommitType.Fix);
  assert.equal(created.filename, `followup-${suffixOf(proposalId)}.md`);
  assert.deepEqual(
    created.tasks.map((task) => task.filename),
    TASK_FILENAMES.map(
      (_name, index) => `followup-${suffixOf(proposalId)}-${index + 1}.md`,
    ),
  );
  assert.deepEqual(
    created.tasks.map((task) => task.content),
    h.tasks.map((task) => task.content),
  );
  assert.deepEqual(h.dependsOn(createdId), [h.nodeId]);
  assert.equal(h.stateOf(createdId), NodeState.Available);
  assert.equal(h.stateOf(h.nodeId), NodeState.Completed);
  assert.equal(result.id, proposalId);
  assert.equal(result.node_id, h.nodeId);
  assert.notEqual(result.approved_at, null);
  assert.equal(result.rejected_at, null);
  assert.equal((await h.list()).items.length, NO_ROWS);
});

test("an approval of the proposal of a Discarded node creates a node with no dependency", async (t) => {
  const h = fixture(t, NodeState.Discarded);
  h.openProposal();
  const result = await h.decide({ approve: true });
  const createdId = result.created_node_id;
  assert.ok(createdId);
  assert.deepEqual(h.dependsOn(createdId), []);
  assert.equal(h.stateOf(h.nodeId), NodeState.Discarded);
});

test("requirement and criterion of the body replace the copies", async (t) => {
  const h = fixture(t, NodeState.Completed);
  h.openProposal();
  const result = await h.decide({
    approve: true,
    requirement: NEW_REQUIREMENT,
    criterion: NEW_CRITERION,
  });
  const created = h.revisionOf(result.created_node_id!);
  assert.equal(created.content.requirement, NEW_REQUIREMENT);
  assert.equal(created.content.criterion, NEW_CRITERION);
  assert.equal(created.content.name, ORIGIN_NAME);
  assert.deepEqual(created.content.verifications, ["true", "pnpm test"]);
});

test("the new node reads the rows of the thread through linkUpdatesOf and no row is copied", async (t) => {
  const h = fixture(t, NodeState.Completed);
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, FIRST_OCCURRED_AT);
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, SECOND_OCCURRED_AT);
  h.openProposal();
  const rowsBefore = h.rows().length;
  const result = await h.decide({ approve: true });
  const createdId = result.created_node_id!;
  h.store.transaction((tx) =>
    openAttempt(tx, createdId, FIRST_REVISION, ACTOR, NODE_TIME),
  );
  const page = h.store.transaction((tx) =>
    linkUpdatesOf(tx, h.dependencies.bindings, createdId, FIRST_ATTEMPT, {}),
  );
  assert.equal(page.total, LINK_ROW_COUNT);
  assert.deepEqual(
    page.items.map((item) => item.new),
    [true, true],
  );
  assert.equal(h.rows().length, rowsBefore);
});

test("approve false rejects the proposal and creates nothing", async (t) => {
  const h = fixture(t, NodeState.Completed);
  const proposalId = h.openProposal();
  const versionBefore = h.version();
  const nodesBefore = h.store.database
    .prepare("SELECT COUNT(*) AS count FROM mission_node")
    .get();
  const result = await h.decide({ approve: false, reason: "No follow-up." });
  assert.equal(result.id, proposalId);
  assert.equal(result.created_node_id, null);
  assert.equal(result.approved_at, null);
  assert.notEqual(result.rejected_at, null);
  assert.deepEqual(
    h.store.database
      .prepare("SELECT COUNT(*) AS count FROM mission_node")
      .get(),
    nodesBefore,
  );
  assert.equal(h.version(), versionBefore);
  assert.equal(h.stateOf(h.nodeId), NodeState.Completed);
  assert.equal((await h.list()).items.length, NO_ROWS);
});

test("requirement or criterion with approve false answers a validation failure", async (t) => {
  const h = fixture(t, NodeState.Completed);
  h.openProposal();
  for (const field of ["requirement", "criterion"])
    await assert.rejects(
      h.decide({ approve: false, [field]: "Text" }),
      (error) => {
        assert.ok(error instanceof ZodError);
        assert.deepEqual(
          error.issues.map((issue) => issue.path),
          [["body", "approve"]],
        );
        return true;
      },
    );
  await assert.rejects(
    h.decide({ approve: true, requirement: "" }),
    (error) => error instanceof ZodError,
  );
  assert.equal((await h.list()).items.length, SINGLE);
});

test("an unknown node, a repeated decision and a stale version refuse", async (t) => {
  const h = fixture(t, NodeState.Completed);
  await assert.rejects(
    h.decide({ approve: false }, createIdentity("node")),
    refusedWith(MissionErrorCode.NodeNotFound),
  );
  await assert.rejects(
    h.decide({ approve: false }),
    refusedWith(MissionErrorCode.ProposalDecided, { node_id: h.nodeId }),
  );
  h.openProposal();
  await assert.rejects(
    h.decide({ approve: true }, h.nodeId, STALE_VERSION),
    refusedWith(MissionErrorCode.VersionConflict),
  );
  await h.decide({ approve: true });
  await assert.rejects(
    h.decide({ approve: true }),
    refusedWith(MissionErrorCode.ProposalDecided, { node_id: h.nodeId }),
  );
});

test("a follow-up decision writes one act trace of the terminal node with two equal states", async (t) => {
  const h = fixture(t, NodeState.Completed);
  h.openProposal();
  await assert.rejects(
    h.decide({ approve: true }, h.nodeId, STALE_VERSION),
    refusedWith(MissionErrorCode.VersionConflict),
  );
  assert.equal(actCalls(h).length, NO_ACTS);
  const versionBefore = h.version();
  await h.decide({ approve: true, reason: "Follow it." });
  assert.equal(actCalls(h).length, SINGLE);
  const [trace, contribution] = actCalls(h)[0]!;
  assert.equal(contribution.operation, Act.DecideFollowup);
  assert.equal(trace.node_id, h.nodeId);
  assert.equal(trace.project_id, h.project_id);
  assert.equal(trace.attempt, LAST_ATTEMPT);
  assert.equal(contribution.attributes[ActAttribute.NodeId], h.nodeId);
  assert.equal(
    contribution.attributes[ActAttribute.StateFrom],
    NodeState.Completed,
  );
  assert.equal(
    contribution.attributes[ActAttribute.StateTo],
    NodeState.Completed,
  );
  assert.equal(
    contribution.attributes[ActAttribute.MissionVersion],
    versionBefore + SINGLE,
  );
});

test("followup list answers the open follow-up proposals of the project with their node", async (t) => {
  const h = fixture(t, NodeState.Completed);
  const first = h.openProposal();
  const page = await h.list();
  assert.equal(page.items.length, SINGLE);
  assert.equal(page.items[0]?.id, first);
  assert.equal(page.items[0]?.node_id, h.nodeId);
  assert.equal(page.items[0]?.assessment_id, null);
  assert.deepEqual(page.items[0]?.content, { node_revision: FIRST_REVISION });
  assert.equal(page.next_cursor, null);
});

test("followup list pages with limit and cursor and omits fix-node and decided proposals", async (t) => {
  const h = fixture(t, NodeState.Completed);
  const other = h.addNode([linkOf()], NodeState.Completed);
  const open = [h.openProposal(), h.openProposal(other)];
  h.store.database
    .prepare("UPDATE mission_proposal SET rejected_at = ? WHERE id = ?")
    .run(NODE_TIME, h.openProposal(other));
  const assessmentId = createIdentity("assessment");
  h.store.transaction((tx) => {
    insertAssessment(tx, {
      id: assessmentId,
      node_id: other,
      attempt: NO_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Defect",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: null,
      actor: JSON.stringify(ACTOR),
      node_revision: FIRST_REVISION,
      created_at: NODE_TIME,
    });
    insertProposal(tx, {
      id: createIdentity(PROPOSAL_IDENTITY_PREFIX),
      node_id: other,
      attempt: NO_ATTEMPT,
      assessment_id: assessmentId,
      content: JSON.stringify({
        dependency_id: h.nodeId,
        name: "Fix",
        requirement: "Repair",
        criterion: "Repaired",
        task: {
          name: "Repair",
          requirement: "Change",
          criterion: "Passes",
          verifications: ["pnpm test"],
        },
      }),
      created_node_id: null,
      approved_at: null,
      rejected_at: null,
      created_at: NODE_TIME,
    });
  });
  const all = await h.list();
  assert.deepEqual(
    all.items.map((item) => item.id),
    [...open].sort().reverse(),
  );
  assert.deepEqual(
    new Set(all.items.map((item) => item.node_id)),
    new Set([h.nodeId, other]),
  );
  const firstPage = await h.list(h.project_id, { limit: String(SINGLE) });
  assert.equal(firstPage.items.length, SINGLE);
  assert.notEqual(firstPage.next_cursor, null);
  const secondPage = await h.list(h.project_id, {
    limit: String(SINGLE),
    cursor: firstPage.next_cursor,
  });
  assert.equal(secondPage.items.length, SINGLE);
  assert.equal(secondPage.next_cursor, null);
  assert.deepEqual(
    [...firstPage.items, ...secondPage.items].map((item) => item.id),
    all.items.map((item) => item.id),
  );
});

test("followup list of a project with no mission answers mission not found", async (t) => {
  const h = fixture(t, NodeState.Completed);
  await assert.rejects(
    h.list(createIdentity("project")),
    refusedWith(MissionErrorCode.MissionNotFound),
  );
});
