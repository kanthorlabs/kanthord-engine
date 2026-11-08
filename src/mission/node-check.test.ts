import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  INTAKE_SERVICE_NAME,
  IntakeErrorCode,
  OutboundRequestState,
  ResultClass,
} from "../intake/contract.ts";
import {
  type ExternalLink,
  ExternalLinkKind,
} from "../kernel/external-link.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  testHumanIdentity,
  testServiceIdentity,
} from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  CheckEndState,
  ClosingEvent,
  ConversationAction,
  type DecodedLinkUpdate,
  FindingCauseOwner,
  FindingKind,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  RepositoryLanding,
  Resolution,
} from "./contract.ts";
import { AdmissionQueue, admitDelivery } from "./delivery-admit.ts";
import {
  LINK_ACTOR,
  LINK_RESOURCE,
  linkOf,
  linkUpdateHarness,
  OTHER_ACTOR,
  OTHER_LINK_NUMBER,
  TRUSTED_ACTOR,
  updateOf,
} from "./link-update-test-support.ts";
import {
  applyEndState,
  DEFERRED_CHECK_RETRY_MS,
  scheduleDeferredCheck,
} from "./node-check.ts";
import { outcomeRecord } from "./record-read.ts";
import {
  insertEvidence,
  readAssessmentsOfAttempt,
  readCurrentOutcome,
  readEvidence,
  readLandedCommitEvidence,
} from "./record-store.ts";
import { readMission, readNode, setNodeState } from "./store.ts";
import {
  ASSESSED_COMMIT,
  externalRequestHarness,
  revokedExecution,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ACTOR = { kind: "human", account: "ulrich", name: "Ulrich" } as const;
const NO_REMOTE_CALLS = 0;
const NO_REPLY_MATCH = { succeeded: false, pending_actor_ids: [] };
const BAD_GATEWAY_STATUS = 502;
const NO_RESULTS = 0;
const FIRST_RESULT_INDEX = 0;
const NO_LANDED_COMMITS = 0;
const SINGLE_FAILURE = 1;
const SINGLE_CALL = 1;
const SINGLE_LANDED_COMMIT = 1;
const FIRST_MISSION_VERSION = 1;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const FIRST_REVISION = 1;
const LANDED_COMMIT_COUNT = 2;
const COMMIT = "a".repeat(40);
const MICROTASK_TURNS = 50;
const FIRST_ROUND_DELAY_MS = 0;
const CHECKS_PER_ROUND = 2;
const ROUNDS_AFTER_FIRST = 2;
const ONE_ROUND = 1;
const ONE_MERGE = 1;
const NO_MERGES = 0;
const REFUSAL = {
  class: ResultClass.FinalRefusal,
  code: "github.final_refusal",
  message: "refused",
};

test("node check reports Mission authorization refusal without calling Intake", async (t) => {
  const h = await fixture(t);
  const original = h.dependencies.bindings.getBindingRevision;
  h.dependencies.bindings.getBindingRevision = (tx, id) => ({
    ...original(tx, id)!,
    disabled: true,
  });
  const remote = t.mock.method(
    h.dependencies.intakeCheck,
    "check",
    async () => ({ end_state: CheckEndState.None, landed_commits: [] }),
  );
  const result = await h.check();
  assert.equal(remote.mock.callCount(), NO_REMOTE_CALLS);
  assert.equal(result.failures.length, SINGLE_FAILURE);
  assert.equal(
    result.failures[0]!.error.error.code,
    MissionErrorCode.AuthorizationRefused,
  );
  assert.deepEqual(result.failures[0]!.error.error.details, {
    reason: "binding_disabled",
  });
});

test("invalid Intake answers leave requests unresolved and stale mission versions refuse result writes", async (t) => {
  const h = await fixture(t);
  for (const answer of [
    { end_state: CheckEndState.Expected, landed_commits: [] },
    { end_state: CheckEndState.Expected, landed_commits: ["bad"] },
    { end_state: CheckEndState.Other, landed_commits: [COMMIT] },
  ]) {
    h.dependencies.intakeCheck.check = async () => answer;
    const result = await h.check();
    assert.equal(result.failures.length, SINGLE_FAILURE);
    assert.equal(result.results.length, NO_RESULTS);
    assert.equal(
      h.store.transaction((tx) => readEvidence(tx, h.request.id)?.end_state),
      null,
    );
  }
  h.dependencies.intakeCheck.check = async () => {
    h.store.transaction((tx) =>
      tx.database
        .prepare(
          "UPDATE mission_mission SET version = version + 1 WHERE id = ?",
        )
        .run(h.mission_id),
    );
    return { end_state: CheckEndState.Expected, landed_commits: [COMMIT] };
  };
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.VersionConflict,
  );
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.request.id)?.end_state),
    null,
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

async function fixture(t: TestContext) {
  const h = await externalRequestHarness(t, IDENTITY);
  const check = () =>
    h.invoke("node.check", {
      params: { node_id: h.node_id },
      query: {},
      body: { expected_mission_version: FIRST_MISSION_VERSION },
    });
  return { ...h, check };
}

test("node check passes the context and the request evidence identity to Intake", async (t) => {
  const h = await fixture(t);
  const remote = t.mock.method(
    h.dependencies.intakeCheck,
    "check",
    async () => ({ end_state: CheckEndState.None, landed_commits: [] }),
  );
  const answer = await h.check();
  assert.equal(
    answer.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(remote.mock.callCount(), SINGLE_CALL);
  const [context, evidenceId] =
    remote.mock.calls[FIRST_RESULT_INDEX]!.arguments;
  assert.equal(context?.signal.aborted, false);
  assert.equal(evidenceId, h.request.id);
});

test("expected checks write every landed commit and close successful external attempts without changing mission version", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.Expected,
    landed_commits: [COMMIT, "b".repeat(40)],
  });
  const answer = await h.check();
  assert.equal(
    answer.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.ExpectedEnd,
  );
  assert.equal(h.node().state, NodeState.Completed);
  h.store.transaction((tx) => {
    assert.equal(
      readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT).length,
      LANDED_COMMIT_COUNT,
    );
    for (const evidence of readLandedCommitEvidence(
      tx,
      h.node_id,
      FIRST_ATTEMPT,
    ))
      assert.deepEqual(JSON.parse(evidence.provenance), {
        kind: "service",
        service: "mission",
      });
    assert.equal(
      readCurrentOutcome(tx, h.node_id)?.result,
      AssessmentResult.Success,
    );
    assert.equal(readMission(tx, h.mission_id)?.version, FIRST_MISSION_VERSION);
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.NoUnresolvedRequest,
  );
  const before = h.store.transaction((tx) =>
    outcomeRecord(
      tx,
      h.dependencies.bindings,
      readCurrentOutcome(tx, h.node_id)!,
    ),
  );
  await h.invoke("evidence.delete", {
    params: { evidence_id: h.request.id },
    query: {},
    body: {
      expected_mission_version: FIRST_MISSION_VERSION,
      force: true,
      reason: "Remove request",
    },
  });
  const after = h.store.transaction((tx) =>
    outcomeRecord(
      tx,
      h.dependencies.bindings,
      readCurrentOutcome(tx, h.node_id)!,
    ),
  );
  assert.deepEqual(after, before);
  assert.equal(after.closing_event, ClosingEvent.ExternalSuccess);
});

test("an admission end state adds the inbound event identity to the landed-commit provenance and the evidence read answers it", async (t) => {
  const h = await fixture(t);
  const inboundEventId = createIdentity("inbound_event");
  const landed = h.store.transaction((tx) => {
    applyEndState(
      tx,
      h.dependencies,
      h.request.id,
      { end_state: CheckEndState.Expected, landed_commits: [COMMIT] },
      Date.now(),
      { inboundEventId },
    );
    return readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT);
  });
  assert.equal(landed.length, SINGLE_LANDED_COMMIT);
  const provenance = {
    kind: "service",
    service: "mission",
    inbound_event_id: inboundEventId,
  };
  assert.deepEqual(
    JSON.parse(landed[FIRST_RESULT_INDEX]!.provenance),
    provenance,
  );
  const read = await h.invoke("evidence.get", {
    params: { evidence_id: landed[FIRST_RESULT_INDEX]!.id },
    query: {},
    body: null,
  });
  assert.deepEqual(read.provenance, provenance);
  assert.equal(h.node().state, NodeState.Completed);
});

test("a conflicting pull request returns the node to rework and keeps the request unresolved", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.Conflict,
    landed_commits: [],
  });
  assert.equal(
    (await h.check()).results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(h.node().state, NodeState.Available);
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.request.id))!.end_state,
    null,
  );
});

test("a pull request with a failed required check returns the node to rework and keeps the request unresolved", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.ChecksFailed,
    landed_commits: [],
  });
  assert.equal(
    (await h.check()).results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(h.node().state, NodeState.Available);
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.request.id))!.end_state,
    null,
  );
});

test("checks_pending leaves the node External.Requested and the request unresolved", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.ChecksPending,
    landed_commits: [],
  });
  assert.equal(
    (await h.check()).results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.request.id))!.end_state,
    null,
  );
});

test("other checks block while none stays unresolved and failed checks retain failure envelopes", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  assert.equal(
    (await h.check()).results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
  h.dependencies.intakeCheck.check = async () => {
    throw new Error("private remote failure");
  };
  const failed = await h.check();
  assert.equal(failed.results.length, NO_RESULTS);
  assert.equal(failed.failures.length, SINGLE_FAILURE);
  assert.equal(
    failed.failures[FIRST_RESULT_INDEX]!.error.request_id,
    h.caller.requestId,
  );
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.Other,
    landed_commits: [],
  });
  await h.check();
  assert.equal(h.node().state, NodeState.Blocked);
});

test("a live claim refuses a conclusive result and keeps a none result unresolved", async (t) => {
  const h = await fixture(t);
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  h.dependencies.schedulerClaims.liveExecutionOf = h.claim;
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  const none = await h.check();
  assert.equal(
    none.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(none.failures.length, NO_RESULTS);
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.Expected,
    landed_commits: [COMMIT],
  });
  const refused = await h.check();
  assert.equal(refused.results.length, NO_RESULTS);
  assert.equal(refused.failures.length, SINGLE_FAILURE);
  assert.equal(
    refused.failures[FIRST_RESULT_INDEX]!.error.error.code,
    MissionErrorCode.ClaimLive,
  );
  assert.equal(h.node().state, NodeState.Evaluating);
  h.store.transaction((tx) => {
    assert.equal(readEvidence(tx, h.request.id)?.end_state, null);
    assert.equal(
      readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT).length,
      NO_LANDED_COMMITS,
    );
  });
});

test("paused nodes keep their state and a concurrent conclusive end state wins", async (t) => {
  const h = await fixture(t);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  h.dependencies.intakeCheck.check = async () => {
    h.store.transaction((tx) =>
      applyEndState(
        tx,
        h.dependencies,
        h.request.id,
        { end_state: CheckEndState.Other, landed_commits: [] },
        Date.now(),
      ),
    );
    return { end_state: CheckEndState.Expected, landed_commits: [COMMIT] };
  };
  const answer = await h.check();
  assert.equal(
    answer.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.OtherEnd,
  );
  assert.equal(h.node().state, NodeState.Paused);
  h.store.transaction((tx) => {
    assert.equal(
      readEvidence(tx, h.request.id)?.end_state,
      CheckEndState.Other,
    );
    assert.equal(
      readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT).length,
      NO_LANDED_COMMITS,
    );
  });
});

function insertNextRequest(
  h: Awaited<ReturnType<typeof externalRequestHarness>>,
): void {
  const nextId = createIdentity("evidence");
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: nextId,
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        subject: "PR",
        requirement_key: "next.pull_request",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.executionActor),
        created_at: FIRST_ATTEMPT,
      },
      [
        {
          id: createIdentity("evidence_asset"),
          evidence_id: nextId,
          kind: AssetKind.Platform,
          content: JSON.stringify({
            ...h.address,
            resource_identity: "repository:github:owner/next",
          }),
          published_at: FIRST_ATTEMPT,
          expired_at: null,
        },
      ],
    ),
  );
}

test("one other end blocks the node after a sibling landed", async (t) => {
  const h = await externalRequestHarness(t, IDENTITY, true);
  insertNextRequest(h);
  h.dependencies.intakeCheck.check = async (_context, evidenceId) =>
    evidenceId === h.request.id
      ? { end_state: CheckEndState.Expected, landed_commits: [COMMIT] }
      : { end_state: CheckEndState.Other, landed_commits: [] };
  const answer = await h.invoke("node.check", {
    params: { node_id: h.node_id },
    query: {},
    body: { expected_mission_version: FIRST_MISSION_VERSION },
  });
  assert.deepEqual(
    answer.results.map((result) => result.resolution).sort(),
    [Resolution.ExpectedEnd, Resolution.OtherEnd].sort(),
  );
  assert.equal(h.node().state, NodeState.Blocked);
  h.store.transaction((tx) =>
    assert.deepEqual(
      readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT).length,
      SINGLE_LANDED_COMMIT,
    ),
  );
});

test("a landed sibling makes its attempt delivered across an unblock", async (t) => {
  const h = await externalRequestHarness(t, IDENTITY, true);
  insertNextRequest(h);
  let nextEnded = false;
  h.dependencies.intakeCheck.check = async (_context, evidenceId) =>
    evidenceId === h.request.id
      ? { end_state: CheckEndState.Expected, landed_commits: [COMMIT] }
      : {
          end_state: nextEnded ? CheckEndState.Other : CheckEndState.None,
          landed_commits: [],
        };
  const check = () =>
    h.invoke("node.check", {
      params: { node_id: h.node_id },
      query: {},
      body: { expected_mission_version: FIRST_MISSION_VERSION },
    });
  const create = (assessmentId: string) =>
    h.invoke("finding.create", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        expected_mission_version: FIRST_MISSION_VERSION,
        assessment_id: assessmentId,
        kind: FindingKind.Blocker,
        task_id: null,
        name: "Missed",
        description: "Found after delivery",
        fix: "Change it",
        why: "It breaks",
        cause_owner: FindingCauseOwner.Agent,
      },
    });
  await check();
  assert.equal(h.node().state, NodeState.ExternalRequested);
  const [assessment] = h.store.transaction((tx) =>
    readAssessmentsOfAttempt(tx, h.node_id, FIRST_ATTEMPT),
  );
  assert.ok(assessment);
  assert.equal((await create(assessment.id)).attempt, FIRST_ATTEMPT);
  nextEnded = true;
  await check();
  assert.equal(h.node().state, NodeState.Blocked);
  assert.equal((await create(assessment.id)).attempt, FIRST_ATTEMPT);
  await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: FIRST_REVISION,
      expected_mission_version: FIRST_MISSION_VERSION,
    },
  });
  assert.equal(h.node().state, NodeState.Available);
  const override = await h.invoke("node.override", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      reason: "Done by hand",
      expected_mission_version: FIRST_MISSION_VERSION,
      expected_state: NodeState.Available,
      expected_attempt: SECOND_ATTEMPT,
      result: AssessmentResult.Success,
    },
  });
  assert.equal(h.node().state, NodeState.Completed);
  assert.ok(override.outcome);
  assert.equal((await create(assessment.id)).attempt, FIRST_ATTEMPT);
  assert.equal(
    (await create(override.outcome.assessment_id)).attempt,
    SECOND_ATTEMPT,
  );
});

test("a stopped merge gets no second call while another request of the node is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
  };
  const h = await externalRequestHarness(t, IDENTITY, true);
  insertNextRequest(h);
  const policy = h.dependencies.bindings.repositoryPolicyOf;
  h.dependencies.bindings.repositoryPolicyOf = (tx, bindingId) => ({
    ...policy(tx, bindingId)!,
    landing: RepositoryLanding.KanthorD,
  });
  let checkCalls = 0;
  let mergeCalls = 0;
  h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
    checkCalls++;
    return evidenceId === h.request.id
      ? { end_state: CheckEndState.None, landed_commits: [] }
      : { end_state: CheckEndState.ChecksPending, landed_commits: [] };
  };
  h.dependencies.intakeCheck.merge = async () => {
    mergeCalls++;
    return REFUSAL;
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(checkCalls, CHECKS_PER_ROUND * ONE_ROUND);
  assert.equal(mergeCalls, ONE_MERGE);
  await advance(DEFERRED_CHECK_RETRY_MS);
  await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(checkCalls, CHECKS_PER_ROUND * (ONE_ROUND + ROUNDS_AFTER_FIRST));
  assert.equal(mergeCalls, ONE_MERGE);
});

test("a request whose assessment is not a success skips the merge and keeps the check loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
  };
  const h = await externalRequestHarness(t, IDENTITY, true);
  insertNextRequest(h);
  const policy = h.dependencies.bindings.repositoryPolicyOf;
  h.dependencies.bindings.repositoryPolicyOf = (tx, bindingId) => ({
    ...policy(tx, bindingId)!,
    landing: RepositoryLanding.KanthorD,
  });
  h.store.database
    .prepare("UPDATE mission_assessment SET result = ? WHERE node_id = ?")
    .run(AssessmentResult.CriterionNotMet, h.node_id);
  let checkCalls = 0;
  let mergeCalls = 0;
  h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
    checkCalls++;
    return evidenceId === h.request.id
      ? { end_state: CheckEndState.None, landed_commits: [] }
      : { end_state: CheckEndState.ChecksPending, landed_commits: [] };
  };
  h.dependencies.intakeCheck.merge = async () => {
    mergeCalls++;
    return REFUSAL;
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  await advance(DEFERRED_CHECK_RETRY_MS);
  await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(checkCalls, CHECKS_PER_ROUND * (ONE_ROUND + ROUNDS_AFTER_FIRST));
  assert.equal(mergeCalls, NO_MERGES);
});

test("a quiescence during a round checks no further request and calls no merge", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
  };
  const h = await externalRequestHarness(t, IDENTITY, true);
  insertNextRequest(h);
  const policy = h.dependencies.bindings.repositoryPolicyOf;
  h.dependencies.bindings.repositoryPolicyOf = (tx, bindingId) => ({
    ...policy(tx, bindingId)!,
    landing: RepositoryLanding.KanthorD,
  });
  const answer =
    Promise.withResolvers<
      Awaited<ReturnType<typeof h.dependencies.intakeCheck.check>>
    >();
  let checkCalls = 0;
  let mergeCalls = 0;
  h.dependencies.intakeCheck.check = async () => {
    checkCalls++;
    return answer.promise;
  };
  h.dependencies.intakeCheck.merge = async () => {
    mergeCalls++;
    return REFUSAL;
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(checkCalls, SINGLE_CALL);
  await h.service.quiesce();
  answer.resolve({ end_state: CheckEndState.None, landed_commits: [] });
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(checkCalls, SINGLE_CALL);
  assert.equal(mergeCalls, NO_MERGES);
});

const EndedClaim = { Revoked: "revoked", Lost: "lost" } as const;

async function deferredCheckAfter(
  t: TestContext,
  ended: (typeof EndedClaim)[keyof typeof EndedClaim],
) {
  const h = await externalRequestHarness(t, IDENTITY);
  const executionId = createIdentity("execution");
  let live = false;
  h.dependencies.schedulerClaims.liveExecutionOf = (_tx, nodeId) =>
    live && nodeId === h.node_id
      ? {
          execution_id: executionId,
          runtime_identity: createIdentity("worker_registration"),
          attempt: FIRST_ATTEMPT,
          pinned_revision: FIRST_ATTEMPT,
        }
      : null;
  h.dependencies.schedulerClaims.revoke = (_tx, nodeId, now) => {
    live = false;
    return revokedExecution(executionId, nodeId, now);
  };
  h.dependencies.intakeCheck.check = async () => {
    h.store.transaction((tx) => {
      setNodeState(tx, h.node_id, NodeState.Evaluating);
      live = true;
    });
    h.store.transaction((tx) => {
      if (ended === EndedClaim.Revoked)
        return h.service.revokeForInstanceArchive(
          tx,
          executionId,
          "relay",
          ACTOR,
        );
      live = false;
      return h.service.failure(tx, h.node_id, FIRST_ATTEMPT, Date.now());
    });
    return { end_state: CheckEndState.Expected, landed_commits: [COMMIT] };
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  t.mock.timers.tick(FIRST_ROUND_DELAY_MS);
  for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
  const state = h.node().state;
  return h.store.transaction((tx) => ({
    state,
    live,
    end_state: readEvidence(tx, h.request.id)?.end_state,
    landed: readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT).length,
  }));
}

test("a forced revocation of a live evaluation claim during a deferred check leaves the state that a loss leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  const revoked = await deferredCheckAfter(t, EndedClaim.Revoked);
  const lost = await deferredCheckAfter(t, EndedClaim.Lost);
  assert.deepEqual(revoked, lost);
  assert.equal(revoked.state, NodeState.Waiting);
  assert.equal(revoked.live, false);
  assert.equal(revoked.end_state, CheckEndState.Expected);
  assert.equal(revoked.landed, SINGLE_LANDED_COMMIT);
});

const NEW_COMMIT = "b".repeat(40);
const LANDED = "c".repeat(40);
const BASE_MOVED = {
  class: ResultClass.ConfirmedFailure,
  code: "git.base_moved",
  message: "moved",
};

const PUSH_REFUSED = {
  class: ResultClass.FinalRefusal,
  code: "git.push_refused",
  message: "remote: error: GH013: Repository rule violations found",
};

function landedAddress(commit: string) {
  return {
    kind: "branch_push",
    resource_identity: "repository:github:owner/repo",
    branch: "main",
    commit,
  };
}

function pushHarness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
  };
  return { advance };
}

function reassess(
  h: Awaited<ReturnType<typeof externalRequestHarness>>,
  commit: string,
): void {
  h.store.database
    .prepare("UPDATE mission_assessment SET tested_input = ? WHERE node_id = ?")
    .run(
      JSON.stringify({
        kind: AssetKind.Repository,
        binding_id: h.repositoryId,
        commit,
      }),
      h.node_id,
    );
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.ExternalRequested),
  );
}

test("a push request lands in the round with the assessed commit and ends External.Success", async (t) => {
  const { advance } = pushHarness(t);
  const h = await externalRequestHarness(
    t,
    IDENTITY,
    false,
    RepositoryAction.Push,
  );
  const merged: string[] = [];
  h.dependencies.intakeCheck.check = async () =>
    merged.length === NO_MERGES
      ? { end_state: CheckEndState.None, landed_commits: [] }
      : { end_state: CheckEndState.Expected, landed_commits: [LANDED] };
  h.dependencies.intakeCheck.merge = async (_context, body) => {
    merged.push(body.commit);
    return landedAddress(LANDED) as never;
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.deepEqual(merged, [ASSESSED_COMMIT]);
  assert.equal(h.node().state, NodeState.Completed);
  h.store.transaction((tx) =>
    assert.equal(
      readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT).length,
      SINGLE_LANDED_COMMIT,
    ),
  );
});

test("two nodes on one base: one lands and the other answers conflict and returns to Available", async (t) => {
  const { advance } = pushHarness(t);
  const first = await externalRequestHarness(
    t,
    IDENTITY,
    false,
    RepositoryAction.Push,
  );
  const second = await externalRequestHarness(
    t,
    IDENTITY,
    false,
    RepositoryAction.Push,
  );
  const remote = { moved: false };
  for (const [h, lands] of [
    [first, true],
    [second, false],
  ] as const) {
    h.dependencies.intakeCheck.check = async () => {
      if (
        h.node().state === NodeState.ExternalRequested &&
        lands &&
        remote.moved
      )
        return { end_state: CheckEndState.Expected, landed_commits: [LANDED] };
      return remote.moved
        ? { end_state: CheckEndState.Conflict, landed_commits: [] }
        : { end_state: CheckEndState.None, landed_commits: [] };
    };
    h.dependencies.intakeCheck.merge = async () => {
      if (remote.moved) return BASE_MOVED;
      remote.moved = true;
      return landedAddress(LANDED) as never;
    };
  }
  scheduleDeferredCheck(first.dependencies, first.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(first.node().state, NodeState.Completed);
  scheduleDeferredCheck(second.dependencies, second.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(second.node().state, NodeState.Available);
  assert.equal(
    second.store.transaction(
      (tx) => readEvidence(tx, second.request.id)!.end_state,
    ),
    null,
  );
});

test("a base that moves between the check and the land retries and the next round answers conflict", async (t) => {
  const { advance } = pushHarness(t);
  const h = await externalRequestHarness(
    t,
    IDENTITY,
    false,
    RepositoryAction.Push,
  );
  let moved = false;
  const keys: string[] = [];
  h.dependencies.intakeCheck.check = async () =>
    moved
      ? { end_state: CheckEndState.Conflict, landed_commits: [] }
      : { end_state: CheckEndState.None, landed_commits: [] };
  h.dependencies.intakeCheck.merge = async (_context, body) => {
    keys.push(body.request_key);
    moved = true;
    return BASE_MOVED;
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.node().state, NodeState.ExternalRequested);
  await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(keys.length, ONE_MERGE);
  assert.equal(h.node().state, NodeState.Available);
});

test("after its rework and a new success the same request lands the new commit", async (t) => {
  const { advance } = pushHarness(t);
  const h = await externalRequestHarness(
    t,
    IDENTITY,
    false,
    RepositoryAction.Push,
  );
  const merges: string[] = [];
  let conflict = true;
  h.dependencies.intakeCheck.check = async () =>
    conflict
      ? { end_state: CheckEndState.Conflict, landed_commits: [] }
      : merges.length === NO_MERGES
        ? { end_state: CheckEndState.None, landed_commits: [] }
        : { end_state: CheckEndState.Expected, landed_commits: [LANDED] };
  h.dependencies.intakeCheck.merge = async (_context, body) => {
    merges.push(body.commit);
    return landedAddress(LANDED) as never;
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.node().state, NodeState.Available);
  conflict = false;
  reassess(h, NEW_COMMIT);
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.deepEqual(merges, [NEW_COMMIT]);
  assert.equal(h.node().state, NodeState.Completed);
});

test("a live claim or a gate file blocks the land of a push request", async (t) => {
  const { advance } = pushHarness(t);
  const h = await externalRequestHarness(
    t,
    IDENTITY,
    false,
    RepositoryAction.Push,
  );
  let merges = NO_MERGES;
  h.dependencies.intakeCheck.check = async () => ({
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  h.dependencies.intakeCheck.merge = async () => {
    merges++;
    return landedAddress(LANDED) as never;
  };
  const free = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = h.claim;
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(merges, NO_MERGES);
  h.dependencies.schedulerClaims.liveExecutionOf = free;
  h.store.database
    .prepare("UPDATE mission_assessment SET gate_files = ? WHERE node_id = ?")
    .run(
      JSON.stringify([{ binding_id: h.repositoryId, paths: ["package.json"] }]),
      h.node_id,
    );
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(merges, NO_MERGES);
});

test("a push refused by a branch rule stops the rounds and a human land with node check completes the node", async (t) => {
  const { advance } = pushHarness(t);
  const h = await externalRequestHarness(
    t,
    IDENTITY,
    false,
    RepositoryAction.Push,
  );
  let humanLanded = false;
  let merges = NO_MERGES;
  let checks = NO_REMOTE_CALLS;
  h.dependencies.intakeCheck.check = async () => {
    checks++;
    return humanLanded
      ? { end_state: CheckEndState.Expected, landed_commits: [LANDED] }
      : { end_state: CheckEndState.None, landed_commits: [] };
  };
  h.dependencies.intakeCheck.merge = async () => {
    merges++;
    return PUSH_REFUSED;
  };
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(merges, ONE_MERGE);
  assert.equal(checks, ONE_ROUND);
  await advance(DEFERRED_CHECK_RETRY_MS);
  await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(merges, ONE_MERGE);
  assert.equal(checks, ONE_ROUND);
  assert.equal(h.node().state, NodeState.ExternalRequested);
  humanLanded = true;
  const answer = await h.invoke("node.check", {
    params: { node_id: h.node_id },
    query: {},
    body: { expected_mission_version: FIRST_MISSION_VERSION },
  });
  assert.equal(
    answer.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.ExpectedEnd,
  );
  assert.equal(h.node().state, NodeState.Completed);
});

const INTAKE_IDENTITY = testServiceIdentity(INTAKE_SERVICE_NAME);
const OTHER_RESOURCE = "conversation:github:acme/other";
const LISTED_EVENT = "issue_comment_listed";
const PLATFORM = "github";
const TWO_ITEMS = 2;
const NO_ITEMS = 0;
const NO_ATTEMPTS = 0;
const CLOSED_ATTEMPTS = 2;
const SINGLE_PROPOSAL = 1;
const SINGLE_ROW = 1;
const NO_READS = 0;
const FIRST_LINK_INDEX = 0;
const SECOND_LINK_INDEX = 1;

function linkCheckFixture(
  t: TestContext,
  state: NodeState = NodeState.Available,
  attempts = NO_ATTEMPTS,
) {
  const h = linkUpdateHarness(t, IDENTITY);
  const bindingId = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR]);
  const otherBindingId = h.addBinding(OTHER_RESOURCE, [TRUSTED_ACTOR]);
  const inbounds = new Set([LINK_RESOURCE, OTHER_RESOURCE]);
  const nodeId = h.addNode([linkOf()], NodeState.Available, [bindingId]);
  h.addAttempts(nodeId, attempts);
  h.store.transaction((tx) => setNodeState(tx, nodeId, state));
  const queue = new AdmissionQueue();
  const intakeCaller: CallerContext = {
    identity: INTAKE_IDENTITY,
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => h.store.transaction(write),
  };
  const updates = new Map<string, DecodedLinkUpdate>();
  const items: string[] = [];
  const handed = new Set<string>();
  const released: string[] = [];
  const reads: {
    project_id: string;
    external_link: ReturnType<typeof linkOf>;
    binding_id: string;
  }[] = [];
  h.dependencies.decoder.decodeLinkUpdate = (input) =>
    updates.get(Buffer.from(input.event).toString()) ?? null;
  h.dependencies.intakeLinks = {
    hasInbound: (_tx, _projectId, resourceIdentity) =>
      inbounds.has(resourceIdentity),
    read: async (_context, input) => {
      reads.push(input);
      return {
        items: items.map((inbound_event_id) => ({ inbound_event_id })),
      };
    },
    releaseHeld: (inboundEventIds) => released.push(...inboundEventIds),
    replyMatch: async () => NO_REPLY_MATCH,
    describe: () => assert.fail("The node check describes no event."),
    handoff: async (_context, inboundEventId) => {
      if (handed.has(inboundEventId)) return null;
      handed.add(inboundEventId);
      return admitDelivery(queue, h.dependencies, intakeCaller, {
        inbound_event_id: inboundEventId,
        project_id: h.project_id,
        platform: PLATFORM,
        resource: LINK_RESOURCE,
        event: Buffer.from(inboundEventId).toString("base64"),
        metadata: { event: LISTED_EVENT },
      });
    },
  };
  const addItem = (update: DecodedLinkUpdate) => {
    const id = createIdentity("inbound_event");
    updates.set(id, update);
    items.push(id);
    return id;
  };
  const check = (id = nodeId) =>
    h.invoke("node.check", {
      params: { node_id: id },
      query: {},
      body: { expected_mission_version: FIRST_MISSION_VERSION },
    });
  const state_of = (id = nodeId) =>
    h.store.transaction((tx) => readNode(tx, id)!.state);
  return {
    ...h,
    nodeId,
    bindingId,
    otherBindingId,
    inbounds,
    reads,
    released,
    addItem,
    check,
    state_of,
  };
}

test("node check releases the hold of each item of a link after the handoff", async (t) => {
  const h = linkCheckFixture(t);
  const first = h.addItem(updateOf({ update_key: "issue_comment:1" }));
  const second = h.addItem(updateOf({ update_key: "issue_comment:2" }));
  await h.check();
  assert.deepEqual(h.released, [first, second]);
});

test("node check releases the hold of each item when a handoff fails", async (t) => {
  const h = linkCheckFixture(t);
  const first = h.addItem(updateOf({ update_key: "issue_comment:1" }));
  h.dependencies.intakeLinks.handoff = async () => {
    throw new OperationError(
      BAD_GATEWAY_STATUS,
      "intake.handoff.failed",
      "failed",
    );
  };
  await assert.rejects(h.check(), OperationError);
  assert.deepEqual(h.released, [first]);
});

test("node check of a node with one link and no request admits two items and answers their counts", async (t) => {
  const h = linkCheckFixture(t);
  h.addItem(updateOf({ update_key: "issue_comment:1" }));
  h.addItem(updateOf({ update_key: "issue_comment:2" }));
  const result = await h.check();
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.link_updates, [
    { external_link: linkOf(), admitted: TWO_ITEMS, duplicate: 0, refused: 0 },
  ]);
  assert.deepEqual(h.reads, [
    {
      project_id: h.project_id,
      external_link: linkOf(),
      binding_id: h.bindingId,
    },
  ]);
  assert.equal(h.rows().length, TWO_ITEMS);
});

test("node check counts a refused item in refused and a repeat in duplicate", async (t) => {
  const h = linkCheckFixture(t);
  h.addItem(updateOf({ update_key: "issue_comment:1" }));
  h.addItem(updateOf({ update_key: "issue_comment:2", actor_automated: true }));
  const first = await h.check();
  assert.deepEqual(first.link_updates, [
    { external_link: linkOf(), admitted: 1, duplicate: 0, refused: 1 },
  ]);
  const second = await h.check();
  assert.deepEqual(second.link_updates, [
    { external_link: linkOf(), admitted: 0, duplicate: TWO_ITEMS, refused: 0 },
  ]);
  assert.equal(h.rows().length, SINGLE_ROW);
});

test("node check counts an item with a stored update key in duplicate", async (t) => {
  const h = linkCheckFixture(t);
  h.addItem(updateOf({ update_key: "issue_comment:1" }));
  h.addItem(updateOf({ update_key: "issue_comment:1" }));
  const result = await h.check();
  assert.deepEqual(result.link_updates, [
    { external_link: linkOf(), admitted: 1, duplicate: 1, refused: 0 },
  ]);
});

test("node check of a Completed node with a link admits an item of a trusted actor and opens a follow-up proposal", async (t) => {
  const h = linkCheckFixture(t, NodeState.Completed, CLOSED_ATTEMPTS);
  h.addItem(
    updateOf({ actor_id: TRUSTED_ACTOR, update_key: "issue_comment:1" }),
  );
  const result = await h.check();
  assert.deepEqual(result.link_updates, [
    { external_link: linkOf(), admitted: 1, duplicate: 0, refused: 0 },
  ]);
  assert.equal(h.proposals().length, SINGLE_PROPOSAL);
  assert.equal(h.state_of(), NodeState.Completed);
});

test("node check of a node in Available with a link admits an item and keeps its state", async (t) => {
  const h = linkCheckFixture(t, NodeState.Available);
  h.addItem(updateOf({ actor_id: LINK_ACTOR, update_key: "issue_comment:1" }));
  h.addItem(updateOf({ actor_id: OTHER_ACTOR, update_key: "issue_comment:2" }));
  const result = await h.check();
  assert.equal(result.link_updates[FIRST_LINK_INDEX]!.admitted, TWO_ITEMS);
  assert.equal(h.state_of(), NodeState.Available);
});

test("node check answers one entry for each link in the order of the links", async (t) => {
  const h = linkCheckFixture(t);
  const nodeId = h.addNode(
    [
      { ...linkOf(), resource_identity: OTHER_RESOURCE },
      linkOf(OTHER_LINK_NUMBER),
    ],
    NodeState.Available,
    [h.bindingId, h.otherBindingId],
  );
  const result = await h.check(nodeId);
  assert.deepEqual(
    result.link_updates.map((entry) => entry.external_link),
    [
      { ...linkOf(), resource_identity: OTHER_RESOURCE },
      linkOf(OTHER_LINK_NUMBER),
    ],
  );
  assert.deepEqual(
    h.reads.map((read) => read.binding_id),
    [h.otherBindingId, h.bindingId],
  );
  assert.equal(result.link_updates[SECOND_LINK_INDEX]!.admitted, NO_ITEMS);
});

test("node check of a node with no request and no link answers 409 no_unresolved_request", async (t) => {
  const h = linkCheckFixture(t);
  await assert.rejects(
    h.check(h.node_id),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.NoUnresolvedRequest,
  );
  assert.equal(h.reads.length, NO_READS);
});

test("node check of a link with no inbound answers 409 and runs no read", async (t) => {
  const h = linkCheckFixture(t);
  const nodeId = h.addNode(
    [linkOf(), { ...linkOf(), resource_identity: OTHER_RESOURCE }],
    NodeState.Available,
    [h.bindingId, h.otherBindingId],
  );
  h.addItem(updateOf());
  h.inbounds.delete(OTHER_RESOURCE);
  await assert.rejects(
    h.check(nodeId),
    (error) =>
      error instanceof OperationError &&
      error.code === IntakeErrorCode.LinkInboundMissing &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          external_link: { ...linkOf(), resource_identity: OTHER_RESOURCE },
        }),
  );
  assert.equal(h.reads.length, NO_READS);
  assert.equal(h.rows().length, NO_ITEMS);
});

test("node check of a link whose binding is disabled answers 403 and runs no read", async (t) => {
  const h = linkCheckFixture(t);
  const original = h.dependencies.bindings.getBindingRevision;
  h.dependencies.bindings.getBindingRevision = (tx, id) => ({
    ...original(tx, id)!,
    disabled: true,
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.AuthorizationRefused,
  );
  assert.equal(h.reads.length, NO_READS);
});

test("node check passes a failed link read on as the failure of the whole check", async (t) => {
  const h = linkCheckFixture(t);
  h.dependencies.intakeLinks.read = async () => {
    throw new OperationError(
      BAD_GATEWAY_STATUS,
      `repository.platform.github.${ResultClass.RetryableRefusal}`,
      "refused",
      { status: null },
    );
  };
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code ===
        `repository.platform.github.${ResultClass.RetryableRefusal}`,
  );
});

const REPLY_RESOURCE = "conversation:github:owner/repo";
const REPLY_KEY = "conversation.reply.0";
const REPLY_UPDATE_KEY = "issue_comment:4242";
const REPLY_LINK_NUMBER = 7;

async function replyFixture(t: TestContext) {
  const h = await fixture(t);
  const conversationId = createIdentity("binding");
  const link: ExternalLink = {
    kind: ExternalLinkKind.GitHubIssue,
    resource_identity: REPLY_RESOURCE,
    number: REPLY_LINK_NUMBER,
  };
  const revisionOf = h.dependencies.bindings.getBindingRevision;
  h.dependencies.bindings.getBindingRevision = (tx, bindingId) =>
    bindingId === conversationId
      ? {
          ...revisionOf(tx, h.repositoryId)!,
          binding_id: conversationId,
          name: "conversation",
          resource_identity: REPLY_RESOURCE,
        }
      : revisionOf(tx, bindingId);
  h.dependencies.bindings.conversationPolicyOf = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "conversation",
    key: "conversation.reply",
    platform: "github",
    repository: "owner/repo",
    credential: "github",
    action: ConversationAction.Reply,
  });
  h.dependencies.intakeLinks.hasInbound = () => true;
  h.dependencies.intakeLinks.read = async () => ({ items: [] });
  h.dependencies.intakeLinks.releaseHeld = () => undefined;
  h.store.transaction((tx) =>
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ?, external_links = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify([h.repositoryId, conversationId, h.storageId]),
        JSON.stringify([link]),
        h.node_id,
      ),
  );
  const replyId = createIdentity("evidence");
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: replyId,
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        subject: "Reply",
        requirement_key: REPLY_KEY,
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.executionActor),
        created_at: FIRST_ATTEMPT,
      },
      [
        {
          id: createIdentity("evidence_asset"),
          evidence_id: replyId,
          kind: AssetKind.Platform,
          content: JSON.stringify({
            kind: PlatformAddressKind.Comment,
            resource_identity: REPLY_RESOURCE,
            update_key: REPLY_UPDATE_KEY,
          }),
          published_at: FIRST_ATTEMPT,
          expired_at: null,
        },
      ],
    ),
  );
  const outbound = new Map<
    string,
    (typeof OutboundRequestState)[keyof typeof OutboundRequestState]
  >([[replyId, OutboundRequestState.Pending]]);
  let platformCalls = NO_REMOTE_CALLS;
  h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
    if (evidenceId === h.request.id) {
      platformCalls++;
      return { end_state: CheckEndState.Expected, landed_commits: [COMMIT] };
    }
    return {
      end_state:
        outbound.get(evidenceId) === OutboundRequestState.Succeeded
          ? CheckEndState.Expected
          : CheckEndState.None,
      landed_commits: [],
    };
  };
  return {
    ...h,
    replyId,
    outbound,
    platformCalls: () => platformCalls,
  };
}

function resolutionsOf(answer: {
  results: { requirement_key: string; resolution: string }[];
}) {
  return answer.results
    .map((result) => [result.requirement_key, result.resolution])
    .sort();
}

test("a node with a pull request and a reply completes only when both reach their expected end states", async (t) => {
  const h = await replyFixture(t);
  assert.deepEqual(
    resolutionsOf(await h.check()),
    [
      ["repo.pull_request", Resolution.ExpectedEnd],
      [REPLY_KEY, Resolution.Unresolved],
    ].sort(),
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
  h.outbound.set(h.replyId, OutboundRequestState.Succeeded);
  assert.deepEqual(resolutionsOf(await h.check()), [
    [REPLY_KEY, Resolution.ExpectedEnd],
  ]);
  assert.equal(h.node().state, NodeState.Completed);
  h.store.transaction((tx) =>
    assert.equal(
      readLandedCommitEvidence(tx, h.node_id, FIRST_ATTEMPT).length,
      SINGLE_LANDED_COMMIT,
    ),
  );
});

test("the check of a reply evidence answers posted from a succeeded outbound request and calls no platform", async (t) => {
  const h = await replyFixture(t);
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
      .run(CheckEndState.Expected, h.request.id),
  );
  h.outbound.set(h.replyId, OutboundRequestState.Succeeded);
  assert.deepEqual(resolutionsOf(await h.check()), [
    [REPLY_KEY, Resolution.ExpectedEnd],
  ]);
  assert.equal(h.platformCalls(), NO_REMOTE_CALLS);
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.replyId)?.end_state),
    CheckEndState.Expected,
  );
});

test("an expected answer for a reply evidence with a landed commit leaves the request unresolved", async (t) => {
  const h = await replyFixture(t);
  h.dependencies.intakeCheck.check = async (_context, evidenceId) => ({
    end_state: CheckEndState.Expected,
    landed_commits: evidenceId === h.replyId ? [COMMIT] : [],
  });
  const answer = await h.check();
  assert.ok(
    answer.failures.some((failure) => failure.evidence_id === h.replyId),
  );
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.replyId)?.end_state),
    null,
  );
});

test("the deferred check resolves an unresolved comment evidence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  const h = await replyFixture(t);
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
      .run(CheckEndState.Expected, h.request.id),
  );
  h.outbound.set(h.replyId, OutboundRequestState.Succeeded);
  scheduleDeferredCheck(h.dependencies, h.node_id, FIRST_ATTEMPT);
  t.mock.timers.tick(FIRST_ROUND_DELAY_MS);
  for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.replyId)?.end_state),
    CheckEndState.Expected,
  );
  assert.equal(h.node().state, NodeState.Completed);
  assert.equal(h.platformCalls(), NO_REMOTE_CALLS);
});
