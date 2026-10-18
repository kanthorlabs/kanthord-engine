import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  ClaimableState,
  ImportFormat,
  MissionErrorCode,
  NodeState,
  RepositoryAction,
  Intent,
  type MissionBindings,
  type UnmatchedClaim,
} from "./contract.ts";
import { openAttempt } from "./record-store.ts";
import { setNodeState } from "./store.ts";
import { databaseSnapshot, missionHarness } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PLAIN_REPOSITORY = "binding_00000000000000000000000001";
const ACTION_REPOSITORY = "binding_00000000000000000000000002";
const REPOSITORY_NAME = "repo";
const REPOSITORY_IDENTITY = "repository:github:owner/repo";
const MACOS = "platform.macos";
const REASON = "plan";
const RENAMED = "Reset on iOS";
const BEFORE_AND_AFTER_READS = 2;
const ONE_REVISION = 1;
const FIRST_ATTEMPT = 1;
const NOW = 100;
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const CONTENT = {
  name: "Add password reset",
  requirement: "Users reset their password.",
  criterion: "A reset email arrives.",
  verifications: ["npm test"],
};

function coverageHarness(t: TestContext) {
  const missing = new Set<string>();
  const latest = { binding_id: PLAIN_REPOSITORY };
  const bindings: MissionBindings = {
    storageBindingOf: () => assert.fail("Coverage reads no storage."),
    resolveBinding: (_tx, projectId, name) => {
      assert.equal(projectId, PROJECT_ID);
      return name === REPOSITORY_NAME
        ? {
            binding_id: latest.binding_id,
            resource_identity: REPOSITORY_IDENTITY,
          }
        : null;
    },
    resolveBindingIdentity: (_tx, projectId) => {
      assert.equal(projectId, PROJECT_ID);
      return {
        binding_id: latest.binding_id,
        resource_identity: REPOSITORY_IDENTITY,
      };
    },
    getBindingRevision: (_tx, bindingId) => ({
      project_id: PROJECT_ID,
      binding_id: bindingId,
      name: REPOSITORY_NAME,
      resource_identity: REPOSITORY_IDENTITY,
      revision: bindingId === ACTION_REPOSITORY ? 2 : 1,
      tombstone: false,
      disabled: false,
    }),
    repositoryPolicyOf: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: PROJECT_ID,
      name: REPOSITORY_NAME,
      address: "git@github.com:owner/repo.git",
      platform: "github",
      ssh_credential: "github-ssh",
      credential: "github",
      base_branch: "main",
      action:
        bindingId === ACTION_REPOSITORY ? RepositoryAction.PullRequest : null,
      landing: "human",
      project_prompt: null,
    }),
  };
  const reads: string[] = [];
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"), {
    bindings,
    schedulerMatch: {
      unmatchedClaims: (tx, projectId) => {
        assert.equal(projectId, PROJECT_ID);
        assert.ok(tx.database.isTransaction);
        reads.push(projectId);
        return h.service
          .claimFactsOf(tx, projectId)
          .flatMap((row): UnmatchedClaim[] =>
            row.claims
              .filter(
                (claim) =>
                  claim === ClaimableState.ExternalRequested ||
                  row.tags.some((tag) => missing.has(tag)),
              )
              .map((claim) => ({
                node_id: row.node_id,
                revision: row.revision,
                claim,
              })),
          );
      },
    },
  });
  h.store.transaction((tx) => h.service.createMission(tx, PROJECT_ID, ACTOR));
  const mission = () =>
    h.invoke("get", {
      params: { project_id: PROJECT_ID },
      query: {},
      body: null,
    });
  const snapshot = () => databaseSnapshot(h.store);
  async function create(filename: string, tags: string[]) {
    const { id, version } = await mission();
    return h.invoke("node.create", {
      params: { mission_id: id },
      query: {},
      body: {
        filename,
        content: {
          ...CONTENT,
          intent: Intent.Implement,
          tags,
          bindings: [REPOSITORY_NAME],
        },
        tasks: [],
        reason: REASON,
        expected_mission_version: version,
      },
    });
  }
  async function refused(
    write: () => Promise<unknown>,
    claims: UnmatchedClaim[],
  ) {
    const before = snapshot();
    await assert.rejects(write(), (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Conflict);
      assert.equal(error.code, MissionErrorCode.TagsUnmatched);
      assert.deepEqual(error.details, { claims });
      return true;
    });
    assert.deepEqual(snapshot(), before);
  }
  return {
    ...h,
    missing,
    latest,
    reads,
    mission,
    snapshot,
    create,
    refused,
  };
}

test("a node create with tags [platform.macos] and no such tag answers mission.node.tags_unmatched and writes nothing", async (t) => {
  const h = coverageHarness(t);
  h.missing.add(MACOS);
  const before = await h.mission();
  await assert.rejects(h.create("ios.md", [MACOS]), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, MissionErrorCode.TagsUnmatched);
    const details = error.details as unknown as { claims: UnmatchedClaim[] };
    assert.deepEqual(
      details.claims.map(({ revision, claim }) => ({ revision, claim })),
      [
        { revision: 1, claim: ClaimableState.Available },
        { revision: 1, claim: ClaimableState.Waiting },
      ],
    );
    return true;
  });
  assert.deepEqual(await h.mission(), before);
  assert.equal(h.reads.length, BEFORE_AND_AFTER_READS);
  const created = await h.create("web.md", []);
  assert.equal(created.revisions.length, ONE_REVISION);
});

test("a node rebind that adds an unmatched pair is refused", async (t) => {
  const h = coverageHarness(t);
  const created = await h.create("api.md", []);
  const nodeId = created.revisions[0]!.node_id;
  h.latest.binding_id = ACTION_REPOSITORY;
  const { id, version } = await h.mission();
  await h.refused(
    () =>
      h.invoke("node.rebind", {
        params: { mission_id: id },
        query: {},
        body: {
          binding_id: ACTION_REPOSITORY,
          node_id: nodeId,
          reason: REASON,
          expected_mission_version: version,
        },
      }),
    [
      {
        node_id: nodeId,
        revision: 2,
        claim: ClaimableState.ExternalRequested,
      },
    ],
  );
});

test("an update of a node with an existing unmatched pair succeeds", async (t) => {
  const h = coverageHarness(t);
  const ios = (await h.create("ios.md", [MACOS])).revisions[0]!;
  const web = (await h.create("web.md", [])).revisions[0]!;
  h.missing.add(MACOS);
  const update = async (
    node: { node_id: string; revision: number },
    filename: string,
    tags: string[],
    name: string,
  ) =>
    h.invoke("node.update", {
      params: { node_id: node.node_id },
      query: {},
      body: {
        filename,
        content: {
          ...CONTENT,
          name,
          intent: Intent.Implement,
          tags,
          bindings: [REPOSITORY_NAME],
        },
        tasks: [],
        reason: REASON,
        expected_revision: node.revision,
        expected_mission_version: (await h.mission()).version,
      },
    });
  const updated = await update(ios, "ios.md", [MACOS], RENAMED);
  assert.equal(updated.revisions[0]!.content.name, RENAMED);
  await h.refused(
    () => update(web, "web.md", [MACOS], "Reset on the web"),
    [
      { node_id: web.node_id, revision: 2, claim: ClaimableState.Available },
      { node_id: web.node_id, revision: 2, claim: ClaimableState.Waiting },
    ],
  );
});

test("an import apply that adds an unmatched pair is refused and writes nothing", async (t) => {
  const h = coverageHarness(t);
  h.missing.add(MACOS);
  const { id, version } = await h.mission();
  const snapshot = {
    format: ImportFormat.Json,
    mission_id: id,
    mission_version: version,
    reason: REASON,
    entries: [
      {
        filename: "ios.md",
        ...CONTENT,
        intent: Intent.Examine,
        tags: [MACOS],
        bindings: [],
      },
    ],
  };
  const preview = await h.invoke("import.preview", {
    params: { mission_id: id },
    query: {},
    body: snapshot,
  });
  const before = h.snapshot();
  await assert.rejects(
    h.invoke("import.apply", {
      params: { mission_id: id },
      query: {},
      body: {
        ...snapshot,
        preview_digest: preview.preview_digest,
        confirmed_retirements: [],
      },
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Conflict);
      assert.equal(error.code, MissionErrorCode.TagsUnmatched);
      const details = error.details as unknown as { claims: UnmatchedClaim[] };
      assert.deepEqual(
        details.claims.map(({ revision, claim }) => ({ revision, claim })),
        [
          { revision: ONE_REVISION, claim: ClaimableState.Available },
          { revision: ONE_REVISION, claim: ClaimableState.Waiting },
        ],
      );
      return true;
    },
  );
  assert.deepEqual(h.snapshot(), before);
});

test("a node unblock with a content change that adds an unmatched pair is refused", async (t) => {
  const h = coverageHarness(t);
  const node = (await h.create("ios.md", [])).revisions[0]!;
  h.store.transaction((tx) => {
    setNodeState(tx, node.node_id, NodeState.Paused);
    openAttempt(tx, node.node_id, FIRST_ATTEMPT, ACTOR, NOW);
  });
  const { version } = await h.mission();
  await h.invoke("node.block", {
    params: { node_id: node.node_id },
    query: {},
    body: {
      reason: REASON,
      expected_mission_version: version,
      expected_state: NodeState.Paused,
      expected_attempt: FIRST_ATTEMPT,
    },
  });
  h.missing.add(MACOS);
  await h.refused(
    () =>
      h.invoke("node.unblock", {
        params: { node_id: node.node_id },
        query: {},
        body: {
          blocked_attempt: FIRST_ATTEMPT,
          expected_revision: node.revision,
          expected_mission_version: version,
          change: {
            content: {
              ...CONTENT,
              intent: Intent.Implement,
              tags: [MACOS],
              bindings: [PLAIN_REPOSITORY],
            },
            reason: REASON,
            tasks: [],
          },
        },
      }),
    [
      { node_id: node.node_id, revision: 2, claim: ClaimableState.Available },
      { node_id: node.node_id, revision: 2, claim: ClaimableState.Waiting },
    ],
  );
});
