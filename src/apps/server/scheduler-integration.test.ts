import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { z } from "zod";
import { ulid } from "ulid";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { custodyOperations } from "../../custody/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import {
  missionOperations,
  NodeState,
  NodeKind,
} from "../../mission/contract.ts";
import {
  schedulerOperations,
  ClaimState,
  WorkPullKind,
  WORK_PULL_TIMEOUT_MS,
  SCHEDULER_TIMEOUT_MS,
} from "../../scheduler/contract.ts";
import {
  OperationResultType,
  OperationLifetime,
  type Operation,
  type OperationResult,
  type ClientOptions,
} from "../../kernel/operation.ts";
import { CancellationContext } from "../../kernel/context.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { gatewayFixture } from "./test-support.ts";

const ONE = 1;
const TWO = 2;
const NO_INPUT = { params: {}, query: {}, body: null };
const PROOF_FAILED = "gateway.invocation.execution_proof_failed";
const NOT_RUNNING = "scheduler.execution.not_running";
const VALIDATION_FAILED = "gateway.request.validation_failed";
const CONTENT = {
  name: "Work",
  requirement: "Do work",
  criterion: "Done",
  verifications: ["true"],
  bindings: [],
};
const CONFIGURATION = {
  agentProvider: "default",
  modelIdentifier: "claude-sonnet-4-5",
  reasoningEffort: "off" as const,
};
type Adapter = "direct" | "http";
const HTTP_ADAPTER = "http";
const MAX_WAIT_TURNS = 100;

function completed<T>(result: OperationResult<T>): T {
  assert.equal(
    result.type,
    OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.ok(result.type === OperationResultType.Completed);
  return result.data;
}
function refused<T>(
  result: OperationResult<T>,
  status: number,
  code: string,
): void {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  assert.ok(result.error.requestId);
}

async function setup(t: TestContext, adapter: Adapter, path?: string) {
  const f = await gatewayFixture(t, {
    path,
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  async function call<T extends Operation>(
    operation: T,
    input: z.input<T["input"]>,
    token = f.token,
    options: ClientOptions = {},
  ) {
    if (adapter === HTTP_ADAPTER)
      return httpClient({ operation }, f.endpoint, token).operation(
        input,
        options,
      );
    const identity = await f.gateway.authentication.authenticate(
      `Bearer ${token}`,
    );
    return directClient({ operation }, f.gateway.invocation).operation(input, {
      ...options,
      identity,
    });
  }
  completed(
    await call(custodyOperations.create, {
      params: {},
      query: {},
      body: {
        name: "anthro",
        platform: "anthropic",
        metadata: null,
        secret: { key: "fake" },
      },
    }),
  );
  completed(
    await call(custodyOperations.create, {
      params: {},
      query: {},
      body: {
        name: "github",
        platform: "github",
        metadata: null,
        secret: { key: "fake" },
      },
    }),
  );
  for (const agentName of ["swe@1", "re@1"])
    completed(
      await call(workerOperations["agent.enablement.put"], {
        params: { agentName },
        query: {},
        body: {
          agentProviders: [
            { name: "default", provider: "anthropic", credential: "anthro" },
          ],
          defaultConfiguration: CONFIGURATION,
        },
      }),
    );
  const projectId = completed(
    await call(projectOperations.create, {
      params: {},
      query: {},
      body: { name: "execution" },
    }),
  ).id;
  completed(
    await call(projectOperations["bindingSet.write"], {
      params: { projectId },
      query: {},
      body: {
        version: 1,
        bindings: {
          repo: {
            kind: "repository",
            config: {
              available: true,
              platform: "github",
              address: "git@github.com:owner/repo.git",
              strategy: { baseBranch: "main" },
              credential: "github",
            },
          },
          general: {
            kind: "worker",
            config: {
              worker: "general@1",
              instanceCount: 2,
              entries: [{ agent: "swe@1", ...CONFIGURATION }],
            },
          },
          reviewer: {
            kind: "worker",
            config: {
              worker: "reviewer@1",
              instanceCount: 1,
              entries: [{ agent: "re@1", ...CONFIGURATION }],
            },
          },
        },
      },
    }),
  );
  const mission = completed(
    await call(missionOperations.get, {
      params: { projectId },
      query: {},
      body: null,
    }),
  );
  const initiative = completed(
    await call(missionOperations["node.create"], {
      params: { missionId: mission.id },
      query: {},
      body: {
        filename: "initiative-1.md",
        kind: NodeKind.Initiative,
        content: CONTENT,
        reason: "plan",
        expectedMissionVersion: 1,
      },
    }),
  );
  const objective = completed(
    await call(missionOperations["node.create"], {
      params: { missionId: mission.id },
      query: {},
      body: {
        filename: "objective-1.md",
        kind: NodeKind.Objective,
        content: { ...CONTENT, bindings: ["repo"] },
        reason: "plan",
        expectedMissionVersion: 2,
        parentId: initiative.revisions[0]!.nodeId,
        expectedParentRevision: 1,
      },
    }),
  );
  const nodeId = objective.revisions[0]!.nodeId;
  const generalToken = await f.machineToken(projectId, "general", "general-a");
  const otherToken = await f.machineToken(projectId, "general", "general-b");
  const reviewerToken = await f.machineToken(projectId, "reviewer", "reviewer");
  const general = completed(
    await call(workerOperations.register, NO_INPUT, generalToken),
  ).runtimeIdentity;
  const other = completed(
    await call(workerOperations.register, NO_INPUT, otherToken),
  ).runtimeIdentity;
  const reviewer = completed(
    await call(workerOperations.register, NO_INPUT, reviewerToken),
  ).runtimeIdentity;
  const pull = (
    runtimeIdentity = general,
    token = generalToken,
    options: ClientOptions = {},
  ) =>
    call(
      schedulerOperations.workPull,
      {
        params: {},
        query: {},
        body: {
          resourceIdentity:
            runtimeIdentity === reviewer
              ? "worker:kanthord:reviewer"
              : "worker:kanthord:general",
          runtimeIdentity,
        },
      },
      token,
      options,
    );
  const release = (
    executionId: string,
    furtherWork = true,
    options: ClientOptions = {},
  ) =>
    call(
      schedulerOperations.executionRelease,
      { params: { executionId }, query: {}, body: { furtherWork } },
      generalToken,
      options,
    );
  const get = (executionId: string) =>
    call(schedulerOperations.executionGet, {
      params: { executionId },
      query: {},
      body: null,
    });
  const node = async () =>
    completed(
      await call(missionOperations["node.get"], {
        params: { nodeId },
        query: {},
        body: null,
      }),
    );
  return {
    f,
    call,
    projectId,
    nodeId,
    generalToken,
    reviewerToken,
    general,
    other,
    otherToken,
    reviewer,
    pull,
    release,
    get,
    node,
  };
}

for (const adapter of ["direct", "http"] as const) {
  test(`${adapter}: pulls are naturally idempotent and release proof precedes replay`, async (t) => {
    const h = await setup(t, adapter);
    const key = ulid();
    const first = completed(
      await h.pull(h.general, h.generalToken, { idempotencyKey: key }),
    );
    assert.ok(first.kind === WorkPullKind.Claimed);
    assert.equal(first.execution.nodeId, h.nodeId);
    for (const idempotencyKey of [key, ulid()])
      assert.deepEqual(
        completed(await h.pull(h.general, h.generalToken, { idempotencyKey })),
        first,
      );
    const context = new CancellationContext();
    const other = h.pull(h.other, h.otherToken, { context });
    for (
      let tries = 0;
      tries < MAX_WAIT_TURNS && !h.f.scheduler.pulling(h.other);
      tries++
    )
      await turn();
    assert.equal(h.f.scheduler.pulling(h.other), true);
    context.cancel();
    assert.notEqual((await other).type, OperationResultType.Completed);
    const releaseKey = ulid();
    completed(
      await h.release(first.execution.executionId, true, {
        idempotencyKey: releaseKey,
      }),
    );
    refused(
      await h.release(first.execution.executionId, true, {
        idempotencyKey: releaseKey,
      }),
      HttpStatus.Forbidden,
      PROOF_FAILED,
    );
    const ended = completed(
      await h.call(
        schedulerOperations.claimGet,
        {
          params: { executionId: first.execution.executionId },
          query: {},
          body: null,
        },
        h.generalToken,
      ),
    );
    assert.equal(ended.claimState, ClaimState.Finished);
    const next = completed(await h.pull());
    assert.ok(next.kind === WorkPullKind.Claimed);
    assert.notEqual(next.execution.executionId, first.execution.executionId);
    assert.equal(next.execution.attempt, ONE);
    const list = completed(
      await h.call(schedulerOperations.executionList, {
        params: { projectId: h.projectId },
        query: {},
        body: null,
      }),
    );
    assert.equal(list.items.length, TWO);
    refused(
      await h.call(schedulerOperations.executionList, {
        params: { projectId: h.projectId },
        query: { attempt: 1 },
        body: null,
      }),
      HttpStatus.BadRequest,
      VALIDATION_FAILED,
    );
  });
}

test("two proved releases race at the transaction, for equal and different payloads", async (t) => {
  const h = await setup(t, "direct");
  const routing = t.mock.method(h.f.mission, "release");
  const registered = h.f.gateway.registry.get(
    schedulerOperations.executionRelease.id,
  );
  const original = registered.handler;
  for (const furtherWork of [true, false]) {
    const result = completed(await h.pull());
    assert.ok(result.kind === WorkPullKind.Claimed);
    const gate = Promise.withResolvers<void>();
    let admitted = 0;
    registered.handler = async (input, caller) => {
      admitted++;
      if (admitted === TWO) gate.resolve();
      await gate.promise;
      return original(input, caller);
    };
    try {
      const [winner, loser] = await Promise.all([
        h.release(result.execution.executionId),
        h.release(result.execution.executionId, furtherWork),
      ]);
      completed(winner);
      refused(loser, HttpStatus.Conflict, NOT_RUNNING);
    } finally {
      registered.handler = original;
    }
  }
  assert.equal(routing.mock.calls.length, TWO);
  const node = await h.node();
  assert.ok(node.kind !== NodeKind.Task);
  assert.equal(node.state, NodeState.Available);
});

test("proof before expiry cannot authorize a release whose transaction begins at the deadline", async (t) => {
  const h = await setup(t, "direct");
  const claim = completed(await h.pull());
  assert.ok(claim.kind === WorkPullKind.Claimed);
  const registered = h.f.gateway.registry.get(
    schedulerOperations.executionRelease.id,
  );
  const original = registered.handler;
  registered.handler = (input, caller) => {
    t.mock.method(Date, "now", () => claim.execution.expiredAt);
    return original(input, caller);
  };
  try {
    refused(
      await h.release(claim.execution.executionId),
      HttpStatus.Conflict,
      NOT_RUNNING,
    );
  } finally {
    registered.handler = original;
  }
  assert.equal(
    h.f.scheduler.executionOf(claim.execution.executionId)?.endedAt,
    null,
  );
});

test("pull, registration resume and human pause settle an expired row before admission", async (t) => {
  const h = await setup(t, "direct");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const first = completed(await h.pull());
  assert.ok(first.kind === WorkPullKind.Claimed);
  now = first.execution.expiredAt;
  const next = completed(await h.pull());
  assert.ok(next.kind === WorkPullKind.Claimed);
  assert.notEqual(next.execution.executionId, first.execution.executionId);
  assert.equal(
    h.f.scheduler.executionOf(first.execution.executionId)?.endedAt,
    now,
  );
  completed(
    await h.call(
      workerOperations["instance.deregister"],
      { params: { runtimeIdentity: h.general }, query: {}, body: null },
      h.generalToken,
    ),
  );
  now = next.execution.expiredAt;
  refused(
    await h.call(workerOperations["instance.resume"], {
      params: { runtimeIdentity: h.general },
      query: {},
      body: null,
    }),
    HttpStatus.Conflict,
    "worker.instance.no_live_execution",
  );
  const node = await h.node();
  assert.ok(node.kind !== NodeKind.Task);
  assert.equal(node.state, NodeState.Executing);
  h.f.scheduler.sweep();
  const third = completed(await h.pull(h.other, h.otherToken));
  assert.ok(third.kind === WorkPullKind.Claimed);
  completed(
    await h.call(
      schedulerOperations.executionRelease,
      {
        params: { executionId: third.execution.executionId },
        query: {},
        body: { furtherWork: true },
      },
      h.otherToken,
    ),
  );
  const fourth = completed(await h.pull(h.other, h.otherToken));
  assert.ok(fourth.kind === WorkPullKind.Claimed);
  now = fourth.execution.expiredAt;
  const pause = completed(
    await h.call(missionOperations["node.pause"], {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        reason: "hold",
        expectedMissionVersion: 3,
        expectedState: NodeState.Available,
        expectedAttempt: 1,
      },
    }),
  );
  assert.ok(pause.node.kind !== NodeKind.Task);
  assert.equal(pause.node.state, NodeState.Paused);
  assert.equal(
    h.f.scheduler.executionOf(fourth.execution.executionId)?.endedAt,
    now,
  );
});

test("Scheduler routes preserve closed inputs, shared envelopes, lifetimes and body bounds", async (t) => {
  const h = await setup(t, "http");
  const invalidFilter = await h.f.request(
    `/api/scheduler/project/${h.projectId}/execution?attempt=1`,
    { headers: { Authorization: `Bearer ${h.f.token}` } },
  );
  assert.equal(invalidFilter.status, HttpStatus.BadRequest);
  const invalidFilterError = (await invalidFilter.json()) as {
    error: { code: string };
    requestId: string;
  };
  assert.equal(invalidFilterError.error.code, VALIDATION_FAILED);
  assert.ok(invalidFilterError.requestId);
  for (const operation of Object.values(schedulerOperations)) {
    const isPull = operation.id === schedulerOperations.workPull.id;
    assert.equal(
      operation.timeoutMs,
      isPull ? WORK_PULL_TIMEOUT_MS : SCHEDULER_TIMEOUT_MS,
    );
    assert.equal(
      operation.lifetime,
      isPull ? OperationLifetime.Wait : OperationLifetime.Unary,
    );
    const path = operation.path
      .replace(":projectId", h.projectId)
      .replace(":executionId", createIdentity("execution"));
    const response = await h.f.request(path + "?unexpected=true", {
      method: operation.method,
      headers: {
        Authorization: `Bearer ${h.f.token}`,
        "Content-Type": "application/json",
      },
      ...(operation.body ? { body: "{}" } : {}),
    });
    assert.equal(response.status, HttpStatus.BadRequest);
    const error = (await response.json()) as {
      error: { code: string };
      requestId: string;
    };
    assert.equal(error.error.code, VALIDATION_FAILED);
    assert.ok(error.requestId);
  }
  for (const operation of [
    schedulerOperations.workPull,
    schedulerOperations.executionRelease,
  ]) {
    const response = await h.f.request(
      operation.path.replace(":executionId", createIdentity("execution")),
      {
        method: operation.method,
        headers: {
          Authorization: `Bearer ${h.generalToken}`,
          "Content-Type": "application/json",
        },
        body: "x".repeat(10 * 1024 * 1024 + 1),
      },
    );
    assert.equal(response.status, HttpStatus.PayloadTooLarge);
  }
});

test("real Mission sweeps steps and evaluation claims below and at the loss limit", async (t) => {
  for (const evaluation of [false, true]) {
    await t.test(evaluation ? "evaluation" : "steps", async (step) => {
      const h = await setup(step, "direct");
      let now = Date.now();
      step.mock.method(Date, "now", () => now);
      const first = completed(await h.pull());
      assert.ok(first.kind === WorkPullKind.Claimed);
      if (evaluation) {
        completed(await h.release(first.execution.executionId));
        completed(
          await h.call(missionOperations["node.ready"], {
            params: { nodeId: h.nodeId },
            query: {},
            body: {
              reason: "review",
              expectedMissionVersion: 3,
              expectedState: NodeState.Available,
              expectedAttempt: 1,
            },
          }),
        );
      }
      const routing = step.mock.method(h.f.mission, "loss");
      const limit = h.f.config.mission.consecutiveLossLimit;
      for (let loss = 1; loss <= limit; loss++) {
        const claim = completed(
          await h.pull(
            evaluation ? h.reviewer : h.general,
            evaluation ? h.reviewerToken : h.generalToken,
          ),
        );
        assert.ok(claim.kind === WorkPullKind.Claimed);
        now = claim.execution.expiredAt;
        h.f.scheduler.sweep();
        h.f.scheduler.sweep();
        assert.equal(routing.mock.calls.length, loss);
        assert.equal(routing.mock.calls.at(-1)!.arguments[2], loss);
        const node = await h.node();
        assert.ok(node.kind !== NodeKind.Task);
        assert.equal(
          node.state,
          loss === limit
            ? NodeState.Paused
            : evaluation
              ? NodeState.Waiting
              : NodeState.Available,
        );
        const queue = completed(
          await h.call(schedulerOperations.queueList, {
            params: { projectId: h.projectId },
            query: {},
            body: null,
          }),
        );
        assert.equal(
          queue.items.some((job) => job.nodeId === h.nodeId),
          loss < limit,
        );
        assert.equal(
          completed(await h.get(claim.execution.executionId)).claimState,
          ClaimState.Lost,
        );
      }
    });
  }
});

test("sweep and human revocation defeat an already proved release with one terminal routing", async (t) => {
  for (const sweep of [true, false]) {
    await t.test(sweep ? "sweep" : "revocation", async (step) => {
      const h = await setup(step, "direct");
      const claim = completed(await h.pull());
      assert.ok(claim.kind === WorkPullKind.Claimed);
      const registered = h.f.gateway.registry.get(
        schedulerOperations.executionRelease.id,
      );
      const original = registered.handler;
      const releases = step.mock.method(h.f.mission, "release");
      registered.handler = async (input, caller) => {
        if (sweep) {
          step.mock.method(Date, "now", () => claim.execution.expiredAt);
          h.f.scheduler.sweep();
        } else
          completed(
            await h.call(missionOperations["node.pause"], {
              params: { nodeId: h.nodeId },
              query: {},
              body: {
                reason: "hold",
                expectedMissionVersion: 3,
                expectedState: NodeState.Executing,
                expectedAttempt: 1,
              },
            }),
          );
        return original(input, caller);
      };
      try {
        refused(
          await h.release(claim.execution.executionId),
          HttpStatus.Conflict,
          NOT_RUNNING,
        );
      } finally {
        registered.handler = original;
      }
      assert.deepEqual(releases.mock.calls, []);
      assert.ok(
        h.f.scheduler.executionOf(claim.execution.executionId)?.endedAt !==
          null,
      );
    });
  }
});

test("ended executions remain readable after reopening a file store", async (t) => {
  const path = join(temporary(t), "scheduler.db");
  let executionId = "";
  await t.test("write and stop", async (step) => {
    const h = await setup(step, "http", path);
    const claim = completed(await h.pull());
    assert.ok(claim.kind === WorkPullKind.Claimed);
    executionId = claim.execution.executionId;
    completed(await h.release(executionId));
  });
  const f = await gatewayFixture(t, { path });
  const result = completed(
    await httpClient(schedulerOperations, f.endpoint, f.token).executionGet({
      params: { executionId },
      query: {},
      body: null,
    }),
  );
  assert.equal(result.claimState, ClaimState.Finished);
  assert.ok(result.endedAt !== null);
});
