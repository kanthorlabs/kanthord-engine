import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  ACTION_REQUEST_TOOL_NAME,
  ActionAssessmentResult,
  ActionNodeState,
  ActionResolution,
  ActionResultKind,
  ActionReadMethod,
  PlatformAddressKind,
  RefusalClass,
  RepositoryAction,
  ResultClass,
  Uncertainty,
  TestedInputKind,
  WorkerErrorCode,
  type ActionContext,
} from "./contract.ts";
import { ActionPerformer } from "./action-performer.ts";

const FIRST_ATTEMPT = 1;
const SINGLE_CALL_COUNT = 1;
const NO_CALLS = 0;
const COMMIT = "b".repeat(40);
const NOT_RUNNING = "scheduler.execution.not_running";
const MERGE_REFUSED = "merge.request.refused";
const SECOND_ATTEMPT = 2;
const DUAL_CALL_COUNT = 2;
const UNPROCESSABLE_STATUS = 422;
const RESOURCE = "repository:github:owner/repo";
const PR = {
  kind: PlatformAddressKind.PullRequest,
  resource_identity: RESOURCE,
  number: 42,
};

const READ_FAILED_MESSAGE = "required check read failed";
const CHECKS_PENDING_MESSAGE = "merge deferred: required checks pending";
const CHECKS_FAILED_MESSAGE = "merge skipped: required checks failed";
const HEAD_COMMIT_CHANGED_MESSAGE = "merge skipped: head commit changed";
const PENDING_CHECKS = ["check", "lint"];
const FAILED_CHECKS = ["check"];

function checksAt(headCommit: string, pending: string[], failed: string[]) {
  return {
    body: {
      head_commit: headCommit,
      base_branch: "main",
      pending,
      failed,
    },
    next_cursor: null,
  };
}

function actionable(t: TestContext) {
  const h = harness(t);
  const snapshot = h.context.current_assessment!.tested_input;
  assert.ok(
    !Array.isArray(snapshot) && snapshot.kind === TestedInputKind.Repository,
  );
  const entry: ActionContext["actions"][number] = {
    action: {
      key: "repo.pull_request",
      binding_id: snapshot.binding_id,
      action: RepositoryAction.PullRequest,
      expected_end_state: "pull_request_merged",
      follows: null,
      configuration: { base_branch: "main", landing: "human" as const },
    },
    resource_identity: RESOURCE,
    resolution: ActionResolution.Unrequested,
    request_evidence_id: null,
    eligible: true,
    gate_files: [],
    reuse_candidates: [],
  };
  h.context.actions.push(entry);
  const evidence = {
    id: createIdentity("evidence"),
    attempt: FIRST_ATTEMPT,
    requirement_key: entry.action.key,
    assets: [{ address: PR }],
  };
  h.dependencies.evidenceRequests.request = async () => ({
    type: OperationResultType.Completed,
    status: HttpStatus.OK,
    data: evidence,
  });
  assert.equal(h.context.actions.length, SINGLE_CALL_COUNT);
  return { ...h, entry, evidence };
}

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  const nodeId = createIdentity("node");
  const claim = {
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    nodeId,
    attempt: FIRST_ATTEMPT,
    pinnedRevision: FIRST_ATTEMPT,
    nodeBranch: `kanthord/${nodeId}`,
    runtimeIdentity: createIdentity("worker_registration"),
    workerBindingId: createIdentity("binding"),
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "harness",
      resourceIdentity: "worker:kanthord:harness",
      projectId: claim.projectId,
      issuedAt: FIRST_ATTEMPT,
    },
    "jwt",
    claim.runtimeIdentity,
  );
  const context: ActionContext = {
    state: ActionNodeState.Evaluating,
    current_assessment: {
      result: ActionAssessmentResult.Success,
      tested_input: {
        kind: TestedInputKind.Repository,
        binding_id: createIdentity("binding"),
        commit: COMMIT,
      },
    },
    actions: [],
  };
  const calls: string[] = [];
  const dependencies: ConstructorParameters<typeof ActionPerformer>[0] = {
    logger: null,
    store,
    schedulerClaims: {
      agentSelectionsOf: () => [],
      agentPinsOf: () => null,
      unendedExecutionOf: () => null,
      requireRunning: (tx, executionId, runtimeIdentity, now) => {
        assert.ok(tx.database.isTransaction);
        assert.equal(executionId, claim.executionId);
        assert.equal(runtimeIdentity, claim.runtimeIdentity);
        assert.ok(Number.isSafeInteger(now));
        calls.push("claim");
        return {
          execution_id: claim.executionId,
          node_id: claim.nodeId,
          attempt: claim.attempt,
          pinned_revision: claim.pinnedRevision,
        };
      },
      runningExecutionOfRuntime: () => assert.fail("unexpected read"),
      activityOf: () => assert.fail("unexpected read"),
    },
    missionActions: {
      authorizeRequest: (tx, evidenceId, suppliedClaim) => {
        assert.ok(tx.database.isTransaction);
        assert.deepEqual(suppliedClaim, claim);
        const entry = context.actions.find((item) =>
          item.reuse_candidates.some(
            (candidate) => candidate.evidence_id === evidenceId,
          ),
        );
        assert.ok(entry);
        return entry.action;
      },
      authorizeAction: (tx, suppliedClaim, key) => {
        assert.ok(tx.database.isTransaction);
        assert.deepEqual(suppliedClaim, claim);
        const entry = context.actions.find((item) => item.action.key === key);
        assert.ok(entry);
        return entry.action;
      },
      actionContextOf: (tx, nodeId, attempt) => {
        assert.ok(tx.database.isTransaction);
        assert.equal(nodeId, claim.nodeId);
        assert.equal(attempt, claim.attempt);
        calls.push("mission");
        return context;
      },
    },
    intakeActions: {
      perform: async () => assert.fail("unexpected dispatch"),
      read: async () => assert.fail("unexpected read"),
    },
    evidenceRequests: {
      request: async () => assert.fail("unexpected request"),
    },
  };
  const performer = new ActionPerformer(dependencies);
  const caller = { context: background, identity };
  return {
    store,
    claim,
    identity,
    context,
    calls,
    dependencies,
    performer,
    caller,
    perform: () => performer.perform(caller, claim),
  };
}

test("admission checks live claim before reading Mission", async (t) => {
  const h = harness(t);
  h.dependencies.schedulerClaims.requireRunning = () => {
    throw new OperationError(HttpStatus.Conflict, NOT_RUNNING, "ended");
  };
  await assert.rejects(h.perform(), {
    code: NOT_RUNNING,
    status: HttpStatus.Conflict,
  });
  assert.equal(h.calls.length, NO_CALLS);
});

test("admission refuses steps claims before any external call", async (t) => {
  const h = harness(t);
  h.context.state = ActionNodeState.Executing;
  await assert.rejects(h.perform(), {
    code: WorkerErrorCode.ClaimNotEvaluation,
    status: HttpStatus.Conflict,
  });
  assert.deepEqual(h.calls, ["claim", "mission"]);
});

test("admission requires a current passing assessment", async (t) => {
  const h = harness(t);
  h.context.current_assessment!.result = ActionAssessmentResult.CriterionNotMet;
  await assert.rejects(h.perform(), {
    code: WorkerErrorCode.AssessmentNotCurrent,
  });
  h.context.current_assessment = null;
  await assert.rejects(h.perform(), {
    code: WorkerErrorCode.AssessmentNotCurrent,
  });
});

test("admission reads one snapshot and no-action context calls no external seam", async (t) => {
  const h = harness(t);
  const transactions = t.mock.method(h.store, "transaction");
  assert.deepEqual(await h.perform(), {
    tool_name: ACTION_REQUEST_TOOL_NAME,
    items: [],
  });
  assert.equal(transactions.mock.callCount(), SINGLE_CALL_COUNT);
  assert.deepEqual(h.calls, ["claim", "mission"]);
});

test("dispatch forwards identity, derived operands and the returned address to Mission", async (t) => {
  const h = actionable(t);
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  const request = t.mock.method(h.dependencies.evidenceRequests, "request");
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.deepEqual(perform.mock.calls[0]!.arguments, [
    { ...h.caller, executionId: h.claim.executionId },
    { key: h.entry.action.key, commit: COMMIT, reusedEvidenceId: null },
    `${h.claim.nodeId}/${FIRST_ATTEMPT}/${h.entry.action.key}`,
  ]);
  const [input, options] = request.mock.calls[0]!.arguments;
  assert.deepEqual(input.body, {
    execution_id: h.claim.executionId,
    attempt: FIRST_ATTEMPT,
    node_revision: FIRST_ATTEMPT,
    requirement_key: h.entry.action.key,
    subject: h.entry.action.key,
    address: PR,
  });
  assert.equal(options.identity, h.identity);
  assert.equal(options.context, background);
  assert.match(
    options.idempotencyKey!,
    /^idempotency_key_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  );
});

test("merge push records the address and commit returned by Intake", async (t) => {
  const h = actionable(t);
  h.entry.action.action = RepositoryAction.MergePush;
  const pushed = {
    kind: PlatformAddressKind.BranchPush,
    resource_identity: RESOURCE,
    branch: "main",
    commit: "d".repeat(40),
  };
  h.dependencies.intakeActions.perform = async (_call, action, requestKey) => {
    assert.equal(
      requestKey,
      `${h.claim.nodeId}/${FIRST_ATTEMPT}/${h.entry.action.key}/${COMMIT}`,
    );
    assert.deepEqual(action, {
      key: h.entry.action.key,
      commit: COMMIT,
      reusedEvidenceId: null,
    });
    return pushed;
  };
  const request = t.mock.method(h.dependencies.evidenceRequests, "request");
  assert.equal((await h.perform()).items[0]?.kind, ActionResultKind.Submitted);
  assert.deepEqual(request.mock.calls[0]?.arguments[0].body.address, pushed);
});

test("no-effect refusal releases the reservation for a later invocation", async (t) => {
  const h = actionable(t);
  const refusal = {
    class: RefusalClass.FinalRefusal,
    code: "repository.platform.github.final_refusal",
    message: "refused",
  };
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => refusal,
  );
  assert.deepEqual((await h.perform()).items, [
    {
      kind: ActionResultKind.FailedBeforeEffect,
      action: {
        key: h.entry.action.key,
        binding_id: h.entry.action.binding_id,
      },
      refusal,
    },
  ]);
  await h.perform();
  assert.equal(perform.mock.callCount(), DUAL_CALL_COUNT);
  assert.equal(
    perform.mock.calls[0]!.arguments[2],
    perform.mock.calls[1]!.arguments[2],
  );
});

test("refused or thrown recording retains the known address as recording uncertainty", async (t) => {
  const h = actionable(t);
  h.dependencies.intakeActions.perform = async () => PR;
  h.dependencies.evidenceRequests.request = async () => ({
    type: OperationResultType.Failure,
    status: HttpStatus.Conflict,
    error: {
      error: { code: NOT_RUNNING, message: "ended", details: null },
      request_id: "request",
    },
  });
  const expected = {
    kind: ActionResultKind.Uncertain,
    action: { key: h.entry.action.key, binding_id: h.entry.action.binding_id },
    uncertainty: Uncertainty.Recording,
    address: PR,
  };
  assert.deepEqual((await h.perform()).items, [expected]);
  const other = actionable(t);
  other.dependencies.intakeActions.perform = async () => PR;
  other.dependencies.evidenceRequests.request = async () => {
    throw new Error("socket");
  };
  assert.deepEqual((await other.perform()).items, [
    {
      ...expected,
      action: {
        key: other.entry.action.key,
        binding_id: other.entry.action.binding_id,
      },
    },
  ]);
});

function humanLanding(t: TestContext) {
  const h = actionable(t);
  h.entry.action.action = RepositoryAction.MergePush;
  h.entry.gate_files = GATE_FILE_PATHS;
  const address = {
    kind: PlatformAddressKind.BranchPush,
    resource_identity: RESOURCE,
    branch: "main",
    commit: COMMIT,
  };
  const pushes = t.mock.method(h.dependencies.intakeActions, "perform");
  return { ...h, address, pushes };
}

test("a merge push with a gate file records the branch push of the tested commit and pushes nothing", async (t) => {
  const h = humanLanding(t);
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  const request = t.mock.method(h.dependencies.evidenceRequests, "request");
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.equal(h.pushes.mock.callCount(), NO_CALLS);
  assert.equal(request.mock.callCount(), SINGLE_CALL_COUNT);
  assert.deepEqual(request.mock.calls[0]?.arguments[0].body.address, h.address);
  assert.deepEqual(warned, [
    [
      { evidence_id: h.evidence.id, gate_files: GATE_FILE_PATHS },
      MERGE_SKIPPED_MESSAGE,
    ],
  ]);
});

test("a lost recording of a human landing keeps the branch push as recording uncertainty", async (t) => {
  const h = humanLanding(t);
  h.dependencies.evidenceRequests.request = async () => {
    throw new Error("socket");
  };
  assert.deepEqual((await h.perform()).items, [
    {
      kind: ActionResultKind.Uncertain,
      action: {
        key: h.entry.action.key,
        binding_id: h.entry.action.binding_id,
      },
      uncertainty: Uncertainty.Recording,
      address: h.address,
    },
  ]);
  assert.equal(h.pushes.mock.callCount(), NO_CALLS);
});

function reusable(t: TestContext) {
  const h = actionable(t);
  h.claim.attempt = SECOND_ATTEMPT;
  h.entry.reuse_candidates.push({
    evidence_id: createIdentity("evidence"),
    attempt: FIRST_ATTEMPT,
    address: PR,
  });
  const body = {
    state: "open",
    head: {
      ref: "kanthord/" + h.claim.nodeId,
      repo: { full_name: "owner/repo" },
    },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
  };
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  assert.equal(h.entry.reuse_candidates.length, SINGLE_CALL_COUNT);
  assert.equal(h.claim.attempt, SECOND_ATTEMPT);
  return { ...h, body, performSpy: perform };
}

test("reuse forwards the matching earlier pull request through Intake perform", async (t) => {
  const h = reusable(t);
  const read = t.mock.method(
    h.dependencies.intakeActions,
    "read",
    async () => ({ body: h.body, next_cursor: null }),
  );
  assert.equal((await h.perform()).items[0]?.kind, ActionResultKind.Submitted);
  assert.deepEqual(read.mock.calls[0]?.arguments, [
    { ...h.caller, executionId: h.claim.executionId },
    ActionReadMethod.PullRequestGet,
    h.entry.reuse_candidates[0]!.evidence_id,
    {},
  ]);
  assert.equal(
    h.performSpy.mock.calls[0]?.arguments[1]?.reusedEvidenceId,
    h.entry.reuse_candidates[0]!.evidence_id,
  );
  assert.equal(
    h.performSpy.mock.calls[0]?.arguments[2],
    `${h.claim.nodeId}/${SECOND_ATTEMPT}/${h.entry.action.key}/${PR.number}/${COMMIT}`,
  );
});

test("an open pull request of the earlier node branch is not reused after a restart from the base branch", async (t) => {
  const h = reusable(t);
  h.claim.nodeBranch = `kanthord/${h.claim.nodeId}-a2`;
  h.dependencies.intakeActions.read = async () => ({
    body: h.body,
    next_cursor: null,
  });
  assert.equal((await h.perform()).items[0]?.kind, ActionResultKind.Submitted);
  assert.equal(h.performSpy.mock.callCount(), SINGLE_CALL_COUNT);
  assert.equal(
    h.performSpy.mock.calls[0]?.arguments[1]?.reusedEvidenceId,
    null,
  );
});

test("closed pull request dispatches fresh and a later matching candidate is selected", async (t) => {
  const h = reusable(t);
  h.dependencies.intakeActions.read = async () => ({
    body: { ...h.body, state: "closed" },
    next_cursor: null,
  });
  await h.perform();
  assert.equal(
    h.performSpy.mock.calls[0]?.arguments[1]?.reusedEvidenceId,
    null,
  );
  const second = createIdentity("evidence");
  h.entry.reuse_candidates.push({
    evidence_id: second,
    attempt: FIRST_ATTEMPT,
    address: { ...PR, number: 43 },
  });
  h.dependencies.intakeActions.read = async (_call, _method, evidenceId) => ({
    body: evidenceId === second ? h.body : { ...h.body, state: "closed" },
    next_cursor: null,
  });
  await h.perform();
  assert.equal(
    h.performSpy.mock.calls[1]?.arguments[1]?.reusedEvidenceId,
    second,
  );
});

test("a candidate change from 42 to 43 with one snapshot gives two request keys", async (t) => {
  const h = reusable(t);
  h.dependencies.intakeActions.read = async () => ({
    body: h.body,
    next_cursor: null,
  });
  await h.perform();
  const second = { ...PR, number: 43 };
  const secondEvidenceId = createIdentity("evidence");
  h.entry.reuse_candidates.push({
    evidence_id: secondEvidenceId,
    attempt: FIRST_ATTEMPT,
    address: second,
  });
  h.dependencies.intakeActions.read = async (_call, _method, evidenceId) => ({
    body:
      evidenceId === secondEvidenceId ? h.body : { ...h.body, state: "closed" },
    next_cursor: null,
  });
  await h.perform();
  const base = `${h.claim.nodeId}/${SECOND_ATTEMPT}/${h.entry.action.key}`;
  assert.deepEqual(
    h.performSpy.mock.calls.map((call) => call.arguments[2]),
    [`${base}/${PR.number}/${COMMIT}`, `${base}/${second.number}/${COMMIT}`],
  );
});

test("read refusal and unknown read outcome dispatch nothing and release the reservation", async (t) => {
  const h = reusable(t);
  h.dependencies.intakeActions.read = async () => ({
    class: RefusalClass.FinalRefusal,
    code: "repository.platform.github.final_refusal",
    message: "refused",
  });
  const first = (await h.perform()).items[0];
  assert.ok(first?.kind === ActionResultKind.FailedBeforeEffect);
  assert.equal(first.refusal.class, RefusalClass.FinalRefusal);
  h.dependencies.intakeActions.read = async () => ({
    class: ResultClass.UnknownOutcome,
    code: "repository.platform.github.unknown_outcome",
    message: "unknown",
  });
  const second = (await h.perform()).items[0];
  assert.ok(second?.kind === ActionResultKind.FailedBeforeEffect);
  assert.equal(second.refusal.class, RefusalClass.ConfirmedFailure);
  assert.equal(h.performSpy.mock.callCount(), NO_CALLS);
});

test("merge push and foreign repository candidates never call read", async (t) => {
  const h = reusable(t);
  h.entry.action.action = RepositoryAction.MergePush;
  await h.perform();
  assert.equal(
    h.performSpy.mock.calls[0]?.arguments[1]?.reusedEvidenceId,
    null,
  );
  h.entry.action.action = RepositoryAction.PullRequest;
  h.entry.reuse_candidates[0]!.address = {
    ...PR,
    resource_identity: "repository:github:other/repo",
  };
  await h.perform();
  assert.equal(
    h.performSpy.mock.calls[1]?.arguments[1]?.reusedEvidenceId,
    null,
  );
});

test("concurrent calls of one execution take a new snapshot after submission", async (t) => {
  const h = actionable(t);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => {
      entered.resolve();
      await gate.promise;
      return PR;
    },
  );
  h.dependencies.evidenceRequests.request = async () => {
    h.entry.eligible = false;
    h.entry.resolution = ActionResolution.Unresolved;
    h.entry.request_evidence_id = h.evidence.id;
    return {
      type: OperationResultType.Completed,
      status: HttpStatus.OK,
      data: h.evidence,
    };
  };
  const first = h.perform();
  await entered.promise;
  const second = h.perform();
  gate.resolve();
  assert.equal((await first).items[0]?.kind, ActionResultKind.Submitted);
  assert.deepEqual((await second).items, []);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
});

test("unknown effect remains reserved across invocations and later executions", async (t) => {
  const h = actionable(t);
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => ({
      class: ResultClass.UnknownOutcome,
      code: "repository.platform.github.unknown_outcome",
      message: "lost",
    }),
  );
  const first = await h.perform();
  assert.deepEqual(await h.perform(), first);
  h.claim.executionId = createIdentity("execution");
  assert.deepEqual(await h.perform(), first);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
});

test("another execution cannot steal an in-flight reservation or invalidate its settlement", async (t) => {
  const h = actionable(t);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => {
      entered.resolve();
      await gate.promise;
      return PR;
    },
  );
  const firstClaim = { ...h.claim };
  const first = h.performer.perform(h.caller, firstClaim);
  await entered.promise;
  h.claim.executionId = createIdentity("execution");
  const contender = (await h.perform()).items[0];
  assert.ok(contender?.kind === ActionResultKind.Uncertain);
  assert.equal(contender.uncertainty, Uncertainty.Effect);
  gate.resolve();
  assert.equal((await first).items[0]?.kind, ActionResultKind.Submitted);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
  await h.perform();
  assert.equal(perform.mock.callCount(), DUAL_CALL_COUNT);
});

test("unclassified perform error persists", async (t) => {
  const h = actionable(t);
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => {
      throw new Error("socket");
    },
  );
  await assert.rejects(h.perform(), /socket/);
  assert.equal((await h.perform()).items[0]?.kind, ActionResultKind.Uncertain);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
});

for (const [status, code] of [
  [HttpStatus.Forbidden, "mission.authorization.refused"],
  [UNPROCESSABLE_STATUS, "intake.outbound.request.action_unmapped"],
] as const)
  test(`a ${status} perform refusal removes the reservation`, async (t) => {
    const h = actionable(t);
    const perform = t.mock.method(
      h.dependencies.intakeActions,
      "perform",
      async () => {
        throw new OperationError(status, code, "refused");
      },
    );
    await assert.rejects(h.perform(), { code });
    await assert.rejects(h.perform(), { code });
    assert.equal(perform.mock.callCount(), DUAL_CALL_COUNT);
  });

for (const [status, code] of [
  [HttpStatus.Conflict, "intake.outbound.request.in_flight"],
  [HttpStatus.InternalServerError, "gateway.invocation.unknown"],
] as const)
  test(`a ${code} perform failure keeps the reservation uncertain`, async (t) => {
    const h = actionable(t);
    const perform = t.mock.method(
      h.dependencies.intakeActions,
      "perform",
      async () => {
        throw new OperationError(status, code, "failed");
      },
    );
    await assert.rejects(h.perform(), { code });
    const item = (await h.perform()).items[0];
    assert.ok(item?.kind === ActionResultKind.Uncertain);
    assert.equal(item.uncertainty, Uncertainty.Effect);
    assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
  });

test("same-attempt request evidence prunes uncertainty without dispatch", async (t) => {
  const h = actionable(t);
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => ({
      class: ResultClass.UnknownOutcome,
      code: "repository.platform.github.unknown_outcome",
      message: "lost",
    }),
  );
  await h.perform();
  h.entry.eligible = false;
  h.entry.resolution = ActionResolution.Unresolved;
  h.entry.request_evidence_id = h.evidence.id;
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
});

test("read exception clears its reservation and every undispatched owned action", async (t) => {
  const h = reusable(t);
  const second = structuredClone(h.entry);
  second.action.key = "z.pull_request";
  second.reuse_candidates = [];
  h.context.actions.push(second);
  h.dependencies.intakeActions.read = async () => {
    throw new Error("read failed");
  };
  await assert.rejects(h.perform(), /read failed/);
  assert.equal(h.performSpy.mock.callCount(), NO_CALLS);
  h.dependencies.intakeActions.read = async () => ({
    body: h.body,
    next_cursor: null,
  });
  const answer = await h.perform();
  assert.deepEqual(
    answer.items.map((item) => item.kind),
    [ActionResultKind.Submitted, ActionResultKind.Submitted],
  );
  assert.equal(h.performSpy.mock.callCount(), DUAL_CALL_COUNT);
});

test("perform exception retains only the dispatched action and clears later reservations", async (t) => {
  const h = actionable(t);
  const second = structuredClone(h.entry);
  second.action.key = "z.pull_request";
  h.context.actions.push(second);
  h.dependencies.intakeActions.perform = async () => {
    throw new Error("socket");
  };
  await assert.rejects(h.perform(), /socket/);
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  const answer = await h.perform();
  assert.deepEqual(
    answer.items.map((item) => item.kind),
    [ActionResultKind.Uncertain, ActionResultKind.Submitted],
  );
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
});

test("mixed GitHub display capitalization reuses the earlier request without changing its address", async (t) => {
  const h = reusable(t);
  h.dependencies.intakeActions.read = async () => ({
    body: {
      ...h.body,
      head: { ...h.body.head, repo: { full_name: "Owner/Repo" } },
      base: { ...h.body.base, repo: { full_name: "OWNER/REPO" } },
    },
    next_cursor: null,
  });
  const request = t.mock.method(h.dependencies.evidenceRequests, "request");
  assert.equal((await h.perform()).items[0]?.kind, ActionResultKind.Submitted);
  assert.equal(
    h.performSpy.mock.calls[0]?.arguments[1]?.reusedEvidenceId,
    h.entry.reuse_candidates[0]!.evidence_id,
  );
  assert.deepEqual(request.mock.calls[0]?.arguments[0].body.address, PR);
  assert.equal(h.performSpy.mock.callCount(), SINGLE_CALL_COUNT);
});

test("kanthord landing requests create, evidence, and merge in order", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  h.dependencies.intakeActions.read = async () => checksAt(COMMIT, [], []);
  const order: string[] = [];
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => {
      order.push("perform");
      return PR;
    },
  );
  h.dependencies.evidenceRequests.request = async () => {
    order.push("evidence");
    return {
      type: OperationResultType.Completed,
      status: HttpStatus.OK,
      data: h.evidence,
    };
  };
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.deepEqual(order, ["perform", "evidence", "perform"]);
  assert.deepEqual(perform.mock.calls[0]!.arguments[1], {
    key: h.entry.action.key,
    commit: COMMIT,
    reusedEvidenceId: null,
  });
  assert.equal(
    perform.mock.calls[0]!.arguments[2],
    `${h.claim.nodeId}/${FIRST_ATTEMPT}/${h.entry.action.key}`,
  );
  assert.deepEqual(perform.mock.calls[1]!.arguments[1], {
    key: h.entry.action.key,
    commit: COMMIT,
    reusedEvidenceId: null,
    mergeEvidenceId: h.evidence.id,
  });
  assert.equal(
    perform.mock.calls[1]!.arguments[2],
    `${h.claim.nodeId}/${FIRST_ATTEMPT}/${h.entry.action.key}/merge/${COMMIT}`,
  );
});

test("human landing makes no merge call", async (t) => {
  const h = actionable(t);
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
});

test("a failed merge does not change the return item and warns with the evidence id", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  h.dependencies.intakeActions.read = async () => checksAt(COMMIT, [], []);
  const warned: unknown[] = [];
  h.dependencies.logger = { warn: (obj: unknown) => warned.push(obj) };
  let callCount = 0;
  h.dependencies.intakeActions.perform = async () => {
    callCount += 1;
    if (callCount === DUAL_CALL_COUNT)
      throw new OperationError(HttpStatus.Forbidden, MERGE_REFUSED, "refused");
    return PR;
  };
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.equal(callCount, DUAL_CALL_COUNT);
  assert.equal(warned.length, SINGLE_CALL_COUNT);
  assert.deepEqual(warned[0], {
    evidence_id: h.evidence.id,
    code: MERGE_REFUSED,
  });
});

function reworkable(t: TestContext) {
  const h = harness(t);
  const snapshot = h.context.current_assessment!.tested_input;
  assert.ok(
    !Array.isArray(snapshot) && snapshot.kind === TestedInputKind.Repository,
  );
  const existingEvidenceId = createIdentity("evidence");
  const entry: ActionContext["actions"][number] = {
    action: {
      key: "repo.pull_request",
      binding_id: snapshot.binding_id,
      action: RepositoryAction.PullRequest,
      expected_end_state: "pull_request_merged",
      follows: null,
      configuration: { base_branch: "main", landing: "kanthord" as const },
    },
    resource_identity: RESOURCE,
    resolution: ActionResolution.Unresolved,
    request_evidence_id: existingEvidenceId,
    eligible: false,
    gate_files: [],
    reuse_candidates: [],
  };
  h.context.actions.push(entry);
  return { ...h, entry, existingEvidenceId };
}

test("rework: unresolved kanthord pull request requests merge with the new tested commit key", async (t) => {
  const h = reworkable(t);
  h.dependencies.intakeActions.read = async () => checksAt(COMMIT, [], []);
  const mergeKeys: string[] = [];
  h.dependencies.intakeActions.perform = async (_call, body, key) => {
    assert.ok(body.mergeEvidenceId, "expected a merge call, not a create");
    mergeKeys.push(key);
    return PR;
  };
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(mergeKeys.length, SINGLE_CALL_COUNT);
  assert.equal(
    mergeKeys[0],
    `${h.claim.nodeId}/${FIRST_ATTEMPT}/${h.entry.action.key}/merge/${COMMIT}`,
  );
});

test("rework: human landing with unresolved request makes no merge call", async (t) => {
  const h = reworkable(t);
  h.entry.action.configuration = { base_branch: "main", landing: "human" };
  let performCount = NO_CALLS;
  h.dependencies.intakeActions.perform = async () => {
    performCount += 1;
    return PR;
  };
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(performCount, NO_CALLS);
});

test("rework: failed merge does not propagate and warns with the evidence id and error code", async (t) => {
  const h = reworkable(t);
  h.dependencies.intakeActions.read = async () => checksAt(COMMIT, [], []);
  const warned: unknown[] = [];
  h.dependencies.logger = { warn: (obj: unknown) => warned.push(obj) };
  h.dependencies.intakeActions.perform = async () => {
    throw new OperationError(HttpStatus.Forbidden, MERGE_REFUSED, "refused");
  };
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(warned.length, SINGLE_CALL_COUNT);
  assert.deepEqual(warned[0], {
    evidence_id: h.existingEvidenceId,
    code: MERGE_REFUSED,
  });
});

test("rework: an operands failure warns and continues; return items stay intact", async (t) => {
  const h = reworkable(t);
  const warned: unknown[] = [];
  h.dependencies.logger = { warn: (obj: unknown) => warned.push(obj) };
  h.entry.action.binding_id = createIdentity("other_binding");
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(warned.length, SINGLE_CALL_COUNT);
  assert.deepEqual(warned[0], {
    evidence_id: h.existingEvidenceId,
    code: WorkerErrorCode.SnapshotAbsent,
  });
});

test("rework: a merge refusal answer warns with evidence_id, class and code", async (t) => {
  const h = reworkable(t);
  h.dependencies.intakeActions.read = async () => checksAt(COMMIT, [], []);
  const warned: unknown[] = [];
  h.dependencies.logger = { warn: (obj: unknown) => warned.push(obj) };
  h.dependencies.intakeActions.perform = async () => ({
    class: ResultClass.FinalRefusal,
    code: "merge.not_allowed",
    message: "Not allowed",
  });
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(warned.length, SINGLE_CALL_COUNT);
  assert.deepEqual(warned[0], {
    evidence_id: h.existingEvidenceId,
    class: ResultClass.FinalRefusal,
    code: "merge.not_allowed",
  });
});

test("one reviewer execution requests both actions", async (t) => {
  const h = actionable(t);
  const otherCommit = "c".repeat(40);
  const otherResource = "repository:github:owner/other";
  const snapshot = h.context.current_assessment!.tested_input;
  assert.ok(
    !Array.isArray(snapshot) && snapshot.kind === TestedInputKind.Repository,
  );
  const other = {
    kind: TestedInputKind.Repository,
    binding_id: createIdentity("binding"),
    commit: otherCommit,
  };
  h.context.current_assessment!.tested_input = [snapshot, other];
  h.context.actions.push({
    ...h.entry,
    action: {
      ...h.entry.action,
      key: "other.merge_push",
      binding_id: other.binding_id,
      action: RepositoryAction.MergePush,
      expected_end_state: "base_branch_pushed",
    },
    resource_identity: otherResource,
  });
  const pushed = {
    kind: PlatformAddressKind.BranchPush,
    resource_identity: otherResource,
    branch: "main",
    commit: otherCommit,
  };
  const performed: string[][] = [];
  h.dependencies.intakeActions.perform = async (_call, action) => {
    performed.push([action.key, action.commit]);
    return action.key === h.entry.action.key ? PR : pushed;
  };
  const request = t.mock.method(h.dependencies.evidenceRequests, "request");
  const items = (await h.perform()).items;
  assert.equal(items.length, DUAL_CALL_COUNT);
  assert.ok(items.every((item) => item.kind === ActionResultKind.Submitted));
  assert.deepEqual(
    performed.sort(),
    [
      ["other.merge_push", otherCommit],
      [h.entry.action.key, COMMIT],
    ].sort(),
  );
  assert.deepEqual(
    request.mock.calls
      .map((call) => call.arguments[0].body.address.kind)
      .sort(),
    [PlatformAddressKind.BranchPush, PlatformAddressKind.PullRequest].sort(),
  );
});

test("a contained pull request snapshot of a kanthord landing makes no merge call", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => ({
      kind: PlatformAddressKind.BranchPush,
      resource_identity: RESOURCE,
      branch: "main",
      commit: "d".repeat(40),
    }),
  );
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
});

const GATE_FILE_PATHS = ["package.json"];
const MERGE_SKIPPED_MESSAGE = "merge skipped: gate files changed";

test("kanthord landing with a gate file requests no merge and warns once", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  h.entry.gate_files = GATE_FILE_PATHS;
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
  assert.deepEqual(warned, [
    [
      { evidence_id: h.evidence.id, gate_files: GATE_FILE_PATHS },
      MERGE_SKIPPED_MESSAGE,
    ],
  ]);
});

test("rework: kanthord landing with a gate file requests no merge and warns once", async (t) => {
  const h = reworkable(t);
  h.entry.gate_files = GATE_FILE_PATHS;
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  let performCount = NO_CALLS;
  h.dependencies.intakeActions.perform = async () => {
    performCount += 1;
    return PR;
  };
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(performCount, NO_CALLS);
  assert.deepEqual(warned, [
    [
      { evidence_id: h.existingEvidenceId, gate_files: GATE_FILE_PATHS },
      MERGE_SKIPPED_MESSAGE,
    ],
  ]);
});

test("a pending required check requests no merge and warns once with the pending names", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  h.dependencies.intakeActions.read = async () =>
    checksAt(COMMIT, PENDING_CHECKS, []);
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
  assert.deepEqual(warned, [
    [
      { evidence_id: h.evidence.id, pending: PENDING_CHECKS },
      CHECKS_PENDING_MESSAGE,
    ],
  ]);
});

test("a failed required check requests no merge and warns once with the failed names", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  h.dependencies.intakeActions.read = async () =>
    checksAt(COMMIT, [], FAILED_CHECKS);
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  assert.deepEqual((await h.perform()).items, [
    { kind: ActionResultKind.Submitted, evidence: h.evidence },
  ]);
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
  assert.deepEqual(warned, [
    [
      { evidence_id: h.evidence.id, failed: FAILED_CHECKS },
      CHECKS_FAILED_MESSAGE,
    ],
  ]);
});

test("a head commit other than the tested commit requests no merge and warns once", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  h.dependencies.intakeActions.read = async () =>
    checksAt("d".repeat(40), [], []);
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  await h.perform();
  assert.equal(perform.mock.callCount(), SINGLE_CALL_COUNT);
  assert.deepEqual(warned, [
    [{ evidence_id: h.evidence.id }, HEAD_COMMIT_CHANGED_MESSAGE],
  ]);
});

test("a refused required check read warns with the class and the code, then requests the merge", async (t) => {
  const h = actionable(t);
  h.entry.action.configuration.landing = "kanthord";
  h.dependencies.intakeActions.read = async () => ({
    class: ResultClass.FinalRefusal,
    code: "read.not_allowed",
    message: "Not allowed",
  });
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  const perform = t.mock.method(
    h.dependencies.intakeActions,
    "perform",
    async () => PR,
  );
  await h.perform();
  assert.equal(perform.mock.callCount(), DUAL_CALL_COUNT);
  assert.deepEqual(warned, [
    [
      {
        evidence_id: h.evidence.id,
        class: ResultClass.FinalRefusal,
        code: "read.not_allowed",
      },
      READ_FAILED_MESSAGE,
    ],
  ]);
});

test("rework: a pending required check requests no merge and warns once", async (t) => {
  const h = reworkable(t);
  h.dependencies.intakeActions.read = async () =>
    checksAt(COMMIT, PENDING_CHECKS, []);
  const warned: unknown[][] = [];
  h.dependencies.logger = {
    warn: (...args: unknown[]) => warned.push(args),
  } as NonNullable<typeof h.dependencies.logger>;
  let performCount = NO_CALLS;
  h.dependencies.intakeActions.perform = async () => {
    performCount += 1;
    return PR;
  };
  assert.deepEqual((await h.perform()).items, []);
  assert.equal(performCount, NO_CALLS);
  assert.deepEqual(warned, [
    [
      { evidence_id: h.existingEvidenceId, pending: PENDING_CHECKS },
      CHECKS_PENDING_MESSAGE,
    ],
  ]);
});
