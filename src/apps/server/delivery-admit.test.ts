import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { OperationError } from "../../kernel/errors.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  ActorKind,
  ActorService,
  AdmissionRefusal,
  AssetKind,
  CheckEndState,
  Disposition,
  EndState,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  missionOperations,
  type PlatformAddress,
} from "../../mission/contract.ts";
import {
  REQUEST_NUMBER,
  externalRequestHarness,
} from "../../mission/test-support.ts";
import { decodeGitHubEvent } from "../../repository/index.ts";

const RESOURCE = "owner/repo";
const MERGE_COMMIT = "e".repeat(40);
const OTHER_NUMBER = 9;
const FIRST_ATTEMPT = 1;
const SINGLE_CALL = 1;
const NO_CALLS = 0;
const FIRST_CHECK = 0;
const SECOND_CHECK = 1;
const SINGLE_LANDED_COMMIT = 1;
const NO_LANDED_COMMITS = 0;
const CHECK_FAILURE_CODE = "repository.platform.github.retryable_refusal";
const BAD_GATEWAY_STATUS = 502;
const PUSHED_COMMIT = "a".repeat(40);
const PUSH_RESOURCE = "repository:github:owner/repo";

function closed(number: number, merged: boolean): string {
  return Buffer.from(
    JSON.stringify({
      action: "closed",
      number,
      pull_request: { merged },
      repository: { full_name: RESOURCE },
    }),
  ).toString("base64");
}

function closedItem(number: number, merged: boolean): string {
  return Buffer.from(
    JSON.stringify({
      number,
      state: "closed",
      closed_at: "2026-10-15T03:57:51Z",
      merged_at: merged ? "2026-10-15T03:57:51Z" : null,
      merge_commit_sha: merged ? MERGE_COMMIT : null,
      base: { ref: "main", repo: { full_name: RESOURCE } },
    }),
  ).toString("base64");
}

function pushed(branch: string): string {
  return Buffer.from(
    JSON.stringify({
      ref: `refs/heads/${branch}`,
      after: PUSHED_COMMIT,
      repository: { full_name: RESOURCE },
    }),
  ).toString("base64");
}

async function fixture(t: TestContext, nextRepository = false) {
  const h = await externalRequestHarness(
    t,
    mintServiceIdentity(INTAKE_SERVICE_NAME),
    nextRepository,
  );
  h.dependencies.decoder = {
    decode: ({ resource, event, metadata }) =>
      decodeGitHubEvent({ resource, event, metadata }),
  };
  const checks: string[] = [];
  const wakes: string[] = [];
  h.dependencies.wakeup.wake = (projectId) => {
    wakes.push(projectId);
  };
  const answer = (
    end_state: (typeof CheckEndState)[keyof typeof CheckEndState],
    landed_commits: string[] = [],
  ) => {
    h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
      checks.push(evidenceId);
      return { end_state, landed_commits };
    };
  };
  const admit = (
    inboundEventId = createIdentity("inbound_event"),
    event = closed(REQUEST_NUMBER, true),
    eventType = "pull_request",
  ) =>
    h.invoke("delivery.admit", {
      params: {},
      query: {},
      body: {
        inbound_event_id: inboundEventId,
        project_id: h.project_id,
        platform: "github",
        resource: RESOURCE,
        event,
        metadata: { event: eventType },
      },
    });
  return { ...h, checks, wakes, answer, admit };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function evidenceOf(h: Harness) {
  return (
    await h.invoke("evidence.list", {
      params: { node_id: h.node_id },
      query: { attempt: FIRST_ATTEMPT },
      body: null,
    })
  ).items;
}

async function landedOf(h: Harness) {
  return (await evidenceOf(h)).filter(
    (item) => item.provenance.kind === ActorKind.Service,
  );
}

async function requestOf(h: Harness) {
  return (await evidenceOf(h)).find((item) => item.id === h.request.id);
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof OperationError && error.code === code,
  );
}

test("a merged pull request sets expected, writes the landed commit with the inbound event and completes the node", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  const inboundEventId = createIdentity("inbound_event");
  assert.deepEqual(await h.admit(inboundEventId), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.deepEqual(h.checks, [h.request.id]);
  assert.equal((await requestOf(h))?.end_state, EndState.Expected);
  const landed = await landedOf(h);
  assert.equal(landed.length, SINGLE_LANDED_COMMIT);
  assert.deepEqual(landed[0]!.provenance, {
    kind: ActorKind.Service,
    service: ActorService.Mission,
    inbound_event_id: inboundEventId,
  });
  assert.equal(h.node().state, NodeState.Completed);
  assert.deepEqual(h.wakes, [h.project_id]);
});

test("a repeat answers duplicate and writes nothing", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  await h.admit();
  const before = await evidenceOf(h);
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Duplicate,
    reason: null,
  });
  assert.equal(h.checks.length, SINGLE_CALL);
  assert.deepEqual(await evidenceOf(h), before);
});

test("a closed pull request sets other and blocks the node", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Other);
  assert.deepEqual(await h.admit(undefined, closed(REQUEST_NUMBER, false)), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.equal((await requestOf(h))?.end_state, EndState.Other);
  assert.equal((await landedOf(h)).length, NO_LANDED_COMMITS);
  assert.equal(h.node().state, NodeState.Blocked);
});

test("an open pull request answers accepted_observation and writes nothing", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.None);
  const before = await evidenceOf(h);
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.equal(h.checks.length, SINGLE_CALL);
  assert.deepEqual(await evidenceOf(h), before);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("an admitted event whose check answers checks_pending changes no state", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.ChecksPending);
  const before = await evidenceOf(h);
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.equal(h.checks.length, SINGLE_CALL);
  assert.deepEqual(await evidenceOf(h), before);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("a failed check propagates its code and writes nothing", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => {
    throw new OperationError(
      BAD_GATEWAY_STATUS,
      CHECK_FAILURE_CODE,
      "Retryable refusal.",
    );
  };
  const before = await evidenceOf(h);
  await rejectsWith(h.admit(), CHECK_FAILURE_CODE);
  assert.deepEqual(await evidenceOf(h), before);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("an undecodable or unmatched event refuses before any check", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  const issue = Buffer.from(
    JSON.stringify({
      action: "opened",
      issue: { number: 3 },
      repository: { full_name: RESOURCE },
    }),
  ).toString("base64");
  assert.deepEqual(await h.admit(undefined, issue, "issues"), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Undecodable,
  });
  assert.deepEqual(await h.admit(undefined, closed(OTHER_NUMBER, true)), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.checks.length, NO_CALLS);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("another service identity refuses with service_mismatch", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  h.caller.identity = mintServiceIdentity(MISSION_SERVICE_NAME);
  await assert.rejects(
    h.admit(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.AuthorizationRefused &&
      JSON.stringify(error.details) ===
        JSON.stringify({ reason: "service_mismatch" }),
  );
  assert.equal(h.checks.length, NO_CALLS);
});

function insertRequest(
  h: Harness,
  requirementKey: string,
  nodeId = h.node_id,
  address: PlatformAddress = h.address,
): string {
  const id = createIdentity("evidence");
  h.store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO mission_evidence (id, node_id, attempt, subject, requirement_key, end_state, verification, provenance, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
      )
      .run(
        id,
        nodeId,
        FIRST_ATTEMPT,
        requirementKey,
        requirementKey,
        canonicalJSON(h.executionActor),
        Date.now(),
      );
    tx.database
      .prepare(
        "INSERT INTO mission_evidence_asset (id, evidence_id, kind, content, published_at, expired_at) VALUES (?, ?, ?, ?, ?, NULL)",
      )
      .run(
        createIdentity("evidence_asset"),
        id,
        AssetKind.Platform,
        canonicalJSON(address),
        Date.now(),
      );
  });
  return id;
}

function deleteRequest(h: Harness): void {
  h.store.transaction((tx) => {
    tx.database
      .prepare("DELETE FROM mission_evidence_asset WHERE evidence_id = ?")
      .run(h.request.id);
    tx.database
      .prepare("DELETE FROM mission_evidence WHERE id = ?")
      .run(h.request.id);
  });
}

function during(h: Harness, change: () => void): void {
  h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
    h.checks.push(evidenceId);
    change();
    return {
      end_state: CheckEndState.Expected,
      landed_commits: [MERGE_COMMIT],
    };
  };
}

async function unchanged(h: Harness, endState: EndState | undefined) {
  assert.equal(h.checks.length, SINGLE_CALL);
  assert.equal((await landedOf(h)).length, NO_LANDED_COMMITS);
  assert.equal((await requestOf(h))?.end_state, endState);
  assert.equal(h.node().state, NodeState.ExternalRequested);
}

test("a live claim keeps a none result and refuses a conclusive result after one check", async (t) => {
  const h = await fixture(t);
  h.dependencies.schedulerClaims.liveExecutionOf = h.claim;
  h.answer(CheckEndState.None);
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  await assert.rejects(
    h.admit(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ClaimLive &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          node_id: h.node_id,
          execution_id: h.context.execution_id,
        }),
  );
  assert.deepEqual(h.checks, [h.request.id, h.request.id]);
  assert.equal((await landedOf(h)).length, NO_LANDED_COMMITS);
  assert.equal((await requestOf(h))?.end_state, undefined);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("a delete of the checked request during the check answers unmatched", async (t) => {
  const h = await fixture(t);
  during(h, () => deleteRequest(h));
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  await unchanged(h, undefined);
});

test("another request that becomes the one unresolved match answers match_changed", async (t) => {
  const h = await fixture(t);
  let replacement = "";
  during(h, () => {
    deleteRequest(h);
    replacement = insertRequest(h, "repo.pull_request");
  });
  await rejectsWith(h.admit(), MissionErrorCode.DeliveryMatchChanged);
  assert.ok(replacement);
  assert.deepEqual(h.wakes, []);
  assert.equal(h.checks.length, SINGLE_CALL);
  assert.equal((await landedOf(h)).length, NO_LANDED_COMMITS);
  assert.equal(
    (await evidenceOf(h)).find((item) => item.id === replacement)?.end_state,
    undefined,
  );
});

test("an attempt that closes during the check writes no end state", async (t) => {
  const h = await fixture(t);
  during(h, () =>
    h.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE mission_attempt SET closed_at = ? WHERE node_id = ?")
        .run(Date.now(), h.node_id),
    ),
  );
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  await unchanged(h, undefined);
});

test("a second matching request that appears during the check answers ambiguous", async (t) => {
  const h = await fixture(t);
  during(h, () => insertRequest(h, "next.pull_request"));
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Ambiguous,
  });
  await unchanged(h, undefined);
});

test("a human check that resolves the request during the check answers duplicate", async (t) => {
  const h = await fixture(t);
  during(h, () =>
    h.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
        .run(EndState.Other, h.request.id),
    ),
  );
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Duplicate,
    reason: null,
  });
  await unchanged(h, EndState.Other);
});

test("an expected result with a further required action leaves the attempt open", async (t) => {
  const h = await fixture(t, true);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.equal((await requestOf(h))?.end_state, EndState.Expected);
  assert.equal((await landedOf(h)).length, SINGLE_LANDED_COMMIT);
  const attempt = await h.invoke("attempt.get", {
    params: { node_id: h.node_id, attempt: FIRST_ATTEMPT },
    query: {},
    body: null,
  });
  assert.equal(attempt.closed_at, null);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("admissions run one at a time and a failed admission releases the next", async (t) => {
  const h = await fixture(t);
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const started: number[] = [];
  h.dependencies.intakeCheck.check = async () => {
    started.push(started.length);
    if (started.length === SINGLE_CALL) {
      await gate;
      throw new OperationError(
        BAD_GATEWAY_STATUS,
        CHECK_FAILURE_CODE,
        "Retryable refusal.",
      );
    }
    return { end_state: CheckEndState.None, landed_commits: [] };
  };
  const registered = h.registry.get(missionOperations["delivery.admit"].id);
  const admit = () =>
    registered.handler(
      missionOperations["delivery.admit"].input.parse({
        params: {},
        query: {},
        body: {
          inbound_event_id: createIdentity("inbound_event"),
          project_id: h.project_id,
          platform: "github",
          resource: RESOURCE,
          event: closed(REQUEST_NUMBER, true),
          metadata: { event: "pull_request" },
        },
      }),
      h.caller,
    ) as Promise<{ disposition: string }>;
  const first = admit();
  const second = admit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, SINGLE_CALL);
  open();
  await rejectsWith(first, CHECK_FAILURE_CODE);
  assert.equal((await second).disposition, Disposition.AcceptedObservation);
  assert.equal(started.length, SINGLE_CALL + SINGLE_CALL);
});

test("a push to the base branch rechecks the pull request and returns a conflicting node to rework", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Conflict);
  assert.deepEqual(await h.admit(undefined, pushed("main"), "push"), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.deepEqual(h.checks, [h.request.id]);
  assert.equal((await requestOf(h))?.end_state, undefined);
  assert.equal(h.node().state, NodeState.Available);
});

test("a push to another branch selects no pull request and answers unmatched", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Conflict);
  assert.deepEqual(await h.admit(undefined, pushed("feature"), "push"), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.checks.length, NO_CALLS);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("a merged closed pull request item rechecks the pull request on its base branch and completes the node", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  const inboundEventId = createIdentity("inbound_event");
  assert.deepEqual(
    await h.admit(
      inboundEventId,
      closedItem(REQUEST_NUMBER, true),
      "pull_request_closed",
    ),
    { disposition: Disposition.AcceptedObservation, reason: null },
  );
  assert.deepEqual(h.checks, [h.request.id]);
  assert.equal((await requestOf(h))?.end_state, EndState.Expected);
  const landed = await landedOf(h);
  assert.deepEqual(
    landed.map((item) => item.provenance),
    [
      {
        kind: ActorKind.Service,
        service: ActorService.Mission,
        inbound_event_id: inboundEventId,
      },
    ],
  );
  assert.equal(h.node().state, NodeState.Completed);
});

test("a merged closed pull request item of an unknown pull request still rechecks the pull request of its base branch", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Conflict);
  assert.deepEqual(
    await h.admit(
      undefined,
      closedItem(OTHER_NUMBER, true),
      "pull_request_closed",
    ),
    { disposition: Disposition.AcceptedObservation, reason: null },
  );
  assert.deepEqual(h.checks, [h.request.id]);
  assert.equal(h.node().state, NodeState.Available);
});

test("an unmerged closed pull request item sets other and blocks the node", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Other);
  assert.deepEqual(
    await h.admit(
      undefined,
      closedItem(REQUEST_NUMBER, false),
      "pull_request_closed",
    ),
    { disposition: Disposition.AcceptedObservation, reason: null },
  );
  assert.equal((await requestOf(h))?.end_state, EndState.Other);
  assert.equal(h.node().state, NodeState.Blocked);
});

test("an unmerged closed pull request item of an unknown pull request is unmatched", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Other);
  assert.deepEqual(
    await h.admit(
      undefined,
      closedItem(OTHER_NUMBER, false),
      "pull_request_closed",
    ),
    { disposition: Disposition.Refused, reason: AdmissionRefusal.Unmatched },
  );
  assert.equal(h.checks.length, NO_CALLS);
});

function pushRequestOf(h: Harness): {
  nodeId: string;
  address: PlatformAddress;
} {
  const nodeId = h.examine_id;
  return {
    nodeId,
    address: {
      kind: PlatformAddressKind.BranchPush,
      resource_identity: PUSH_RESOURCE,
      branch: "main",
      commit: PUSHED_COMMIT,
    },
  };
}

test("a live claim on the exact push request refuses the admission and leaves a conflicting pull request untouched", async (t) => {
  const h = await fixture(t);
  const push = pushRequestOf(h);
  const exact = insertRequest(h, "repo.merge_push", push.nodeId, push.address);
  h.dependencies.schedulerClaims.liveExecutionOf = (tx, nodeId, now) =>
    nodeId === push.nodeId ? h.claim(tx, nodeId, now) : null;
  h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
    h.checks.push(evidenceId);
    return evidenceId === exact
      ? { end_state: CheckEndState.Expected, landed_commits: [MERGE_COMMIT] }
      : { end_state: CheckEndState.Conflict, landed_commits: [] };
  };
  await assert.rejects(
    h.admit(undefined, pushed("main"), "push"),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ClaimLive &&
      (error.details as { node_id: string }).node_id === push.nodeId,
  );
  assert.deepEqual(h.checks, [exact, h.request.id]);
  assert.deepEqual(h.wakes, []);
  assert.equal((await requestOf(h))?.end_state, undefined);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("an exact push request that becomes ambiguous during the check leaves a conflicting pull request untouched", async (t) => {
  const h = await fixture(t, true);
  const push = pushRequestOf(h);
  const exact = insertRequest(h, "repo.merge_push", push.nodeId, push.address);
  let next = "";
  h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
    h.checks.push(evidenceId);
    if (evidenceId !== exact)
      return { end_state: CheckEndState.Conflict, landed_commits: [] };
    next = insertRequest(h, "next.pull_request", h.node_id, push.address);
    return {
      end_state: CheckEndState.Expected,
      landed_commits: [MERGE_COMMIT],
    };
  };
  assert.deepEqual(await h.admit(undefined, pushed("main"), "push"), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Ambiguous,
  });
  assert.equal(h.checks[FIRST_CHECK], exact);
  assert.deepEqual(
    h.checks.slice(SECOND_CHECK).sort(),
    [h.request.id, next].sort(),
  );
  assert.equal((await requestOf(h))?.end_state, undefined);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

const OTHER_COMMIT = "c".repeat(40);

function branchPushOf(commit: string): PlatformAddress {
  return {
    kind: PlatformAddressKind.BranchPush,
    resource_identity: PUSH_RESOURCE,
    branch: "main",
    commit,
  };
}

async function humanLandingFixture(t: TestContext, commit: string) {
  const h = await fixture(t);
  const policyOf = h.dependencies.bindings.repositoryPolicyOf;
  h.dependencies.bindings.repositoryPolicyOf = (tx, bindingId) => ({
    ...policyOf(tx, bindingId)!,
    action: RepositoryAction.MergePush,
  });
  deleteRequest(h);
  const landing = insertRequest(
    h,
    "repo.merge_push",
    h.node_id,
    branchPushOf(commit),
  );
  return { ...h, landing };
}

test("a push to the base branch with no exact match checks a human-landing branch push request and completes its node", async (t) => {
  const h = await humanLandingFixture(t, OTHER_COMMIT);
  h.answer(CheckEndState.Expected, [OTHER_COMMIT]);
  assert.deepEqual(await h.admit(undefined, pushed("main"), "push"), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.deepEqual(h.checks, [h.landing]);
  assert.equal(h.node().state, NodeState.Completed);
});

test("a push to another branch checks no branch push request", async (t) => {
  const h = await humanLandingFixture(t, OTHER_COMMIT);
  h.answer(CheckEndState.Expected, [OTHER_COMMIT]);
  assert.deepEqual(await h.admit(undefined, pushed("feature"), "push"), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.checks.length, NO_CALLS);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("an exact push match checks its request once", async (t) => {
  const h = await humanLandingFixture(t, PUSHED_COMMIT);
  h.answer(CheckEndState.Expected, [PUSHED_COMMIT]);
  assert.deepEqual(await h.admit(undefined, pushed("main"), "push"), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.deepEqual(h.checks, [h.landing]);
  assert.equal(h.node().state, NodeState.Completed);
});
