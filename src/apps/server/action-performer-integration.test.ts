import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { z } from "zod";
import { ulid } from "ulid";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import {
  missionOperations,
  NodeKind,
  AssetKind,
  AssessmentResult,
  NodeState,
} from "../../mission/contract.ts";
import { schedulerOperations, WorkPullKind } from "../../scheduler/contract.ts";
import {
  workerOperations,
  ActionResultKind,
  ACTION_REQUEST_TIMEOUT_MS,
  RefusalClass,
} from "../../worker/contract.ts";
import {
  OperationResultType,
  OperationLifetime,
  type Operation,
  type OperationResult,
} from "../../kernel/operation.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { OperationError } from "../../kernel/errors.ts";
import {
  FAKE_SSH_IDENTITY,
  fakeGitHub,
  gatewayFixture,
} from "./test-support.ts";

const HTTP = "http";
const DIRECT = "direct";
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_CALL = 1;
const TWO_INSTANCES = 2;
const SECOND_REVISION = 2;
const SUCCESSFUL_EXIT = 0;
const INITIAL_POLL_COUNT = 0;
const NO_CALLS = 0;
const POLLS = 100;
const REDIRECTION = 300;
const COMMIT = "b".repeat(40);
const REPOSITORY_BINDING = "repo";
const NO_INPUT = { params: {}, query: {}, body: null };
const PROOF_FAILED = "gateway.invocation.execution_proof_failed";
const UNPROCESSABLE_STATUS = 422;
const TWO_REQUESTS = 2;
const FINAL_REFUSAL_CODE = "repository.platform.github.final_refusal";
const REVOKED_CODE = "credential.revision.revoked";
const CONTENT = {
  name: "Work",
  requirement: "Work",
  criterion: "Done",
  verifications: ["true"],
  bindings: [],
};

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.ok(result.status >= HttpStatus.OK && result.status < REDIRECTION);
  return result.data;
}

function refused<T>(result: OperationResult<T>, status: number, code: string) {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  assert.ok(result.error.request_id);
}

async function setup(t: TestContext, adapter: typeof HTTP | typeof DIRECT) {
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
  });
  const creates = () =>
    gitHub.calls.filter((item) => item.method === HttpMethod.Post).length;
  async function call<T extends Operation>(
    operation: T,
    input: z.input<T["input"]>,
    token = fixture.token,
    transport = adapter,
    idempotencyKey = ulid(),
  ) {
    if (transport === HTTP)
      return httpClient({ operation }, fixture.endpoint, token).operation(
        input,
        { idempotencyKey },
      );
    const identity = await fixture.gateway.authentication.authenticate(
      `Bearer ${token}`,
    );
    return directClient({ operation }, fixture.gateway.invocation).operation(
      input,
      { identity, idempotencyKey },
    );
  }
  completed(
    await call(repositoryOperations.create, {
      params: {},
      query: {},
      body: {
        name: "github",
        platform: "github",
        metadata: null,
        secret: { key: "test-secret" },
      },
    }),
  );
  completed(
    await call(repositoryOperations.create, {
      params: {},
      query: {},
      body: {
        name: "github-ssh",
        platform: "ssh",
        metadata: {
          host: "github.com",
          hostname: "github.com",
          port: 22,
          identity_file: "~/.ssh/id_rsa",
        },
        secret: {},
      },
    }),
  );
  const projectId = completed(
    await call(projectOperations.create, {
      params: {},
      query: {},
      body: { name: "actions" },
    }),
  ).id;
  completed(
    await call(projectOperations["bindingSet.write"], {
      params: { project_id: projectId },
      query: {},
      body: {
        version: FIRST_REVISION,
        bindings: {
          repo: {
            kind: "repository",
            config: {
              available: true,
              platform: "github",
              address: "git@github.com:owner/repo.git",
              ssh_credential: "github-ssh",
              credential: "github",
              strategy: {
                base_branch: "main",
                action: {
                  name: "pull_request",
                  follows: { type: "assessment_passed" },
                },
              },
            },
          },
          harness: {
            kind: "worker",
            config: { worker: "claude@1", instance_count: TWO_INSTANCES },
          },
        },
      },
    }),
  );
  const bindings = completed(
    await call(projectOperations["binding.list"], {
      params: { project_id: projectId },
      query: {},
      body: null,
    }),
  );
  const binding = bindings.items.find(
    (item) => item.name === REPOSITORY_BINDING,
  )!;
  const mission = completed(
    await call(missionOperations.get, {
      params: { project_id: projectId },
      query: {},
      body: null,
    }),
  );
  const initiative = completed(
    await call(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename: "initiative-1.md",
        kind: NodeKind.Initiative,
        content: CONTENT,
        reason: "plan",
        expected_mission_version: FIRST_REVISION,
      },
    }),
  );
  const objective = completed(
    await call(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename: "objective-1.md",
        kind: NodeKind.Objective,
        content: { ...CONTENT, bindings: [binding.id] },
        reason: "plan",
        expected_mission_version: SECOND_REVISION,
        parent_id: initiative.revisions[0]!.node_id,
        expected_parent_revision: FIRST_REVISION,
      },
    }),
  );
  const nodeId = objective.revisions[0]!.node_id;
  const token = await fixture.machineToken(projectId, "harness", "first");
  const runtimeIdentity = completed(
    await call(workerOperations.register, NO_INPUT, token),
  ).runtime_identity;
  const pull = async () => {
    const result = completed(
      await call(
        schedulerOperations.workPull,
        {
          params: {},
          query: {},
          body: {
            runtime_identity: runtimeIdentity,
            resource_identity: "worker:kanthord:harness",
          },
        },
        token,
      ),
    );
    assert.equal(result.kind, WorkPullKind.Claimed);
    assert.ok(result.kind === WorkPullKind.Claimed);
    return result.execution;
  };
  const steps = await pull();
  const snapshot = {
    kind: AssetKind.Repository,
    binding_id: binding.id,
    commit: COMMIT,
  };
  const work = completed(
    await call(
      missionOperations["evidence.submit"],
      {
        params: { node_id: nodeId },
        query: {},
        body: {
          execution_id: steps.execution_id,
          attempt: FIRST_ATTEMPT,
          node_revision: FIRST_REVISION,
          subject: "work",
          assets: [{ kind: AssetKind.Repository, address: snapshot }],
        },
      },
      token,
    ),
  );
  completed(
    await call(
      schedulerOperations.executionRelease,
      {
        params: { execution_id: steps.execution_id },
        query: {},
        body: { further_work: false },
      },
      token,
    ),
  );
  const execution = await pull();
  const context = {
    execution_id: execution.execution_id,
    attempt: FIRST_ATTEMPT,
    node_revision: FIRST_REVISION,
  };
  const run = completed(
    await call(
      missionOperations["evidence.submit"],
      {
        params: { node_id: nodeId },
        query: {},
        body: {
          ...context,
          subject: "verification",
          assets: [
            {
              kind: AssetKind.Produced,
              content: {
                media_type: "text/plain",
                encoding: "base64",
                data: "b2s=",
              },
            },
          ],
          verification: {
            tested_input: snapshot,
            results: [
              {
                command: "true",
                exit_code: SUCCESSFUL_EXIT,
                signal: null,
                timed_out: false,
              },
            ],
          },
        },
      },
      token,
    ),
  );
  const assessment = completed(
    await call(
      missionOperations["assessment.submit"],
      {
        params: { node_id: nodeId },
        query: {},
        body: {
          ...context,
          evidence_ids: [work.evidence.id, run.evidence.id],
          child_outcome_ids: [],
          result: AssessmentResult.Success,
          rationale: "met",
          tested_input: snapshot,
        },
      },
      token,
    ),
  );
  assert.ok("state" in assessment.node);
  assert.equal(assessment.node.state, NodeState.Evaluating);
  const request = (transport = adapter, key = ulid(), auth = token) =>
    call(
      workerOperations["action.request"],
      {
        params: { execution_id: execution.execution_id },
        query: {},
        body: null,
      },
      auth,
      transport,
      key,
    );
  return {
    fixture,
    gitHub,
    creates,
    call,
    request,
    token,
    project_id: projectId,
    node_id: nodeId,
  };
}

test("both adapters serialize one execution and replay the completed request", async (t) => {
  const h = await setup(t, DIRECT);
  const release = h.gitHub.hold();
  const key = ulid();
  const first = h.request(HTTP, key);
  for (
    let poll = INITIAL_POLL_COUNT;
    poll < POLLS && h.creates() === NO_CALLS;
    poll++
  )
    await setImmediate();
  assert.equal(h.creates(), SINGLE_CALL);
  const second = h.request(DIRECT);
  release();
  const [one, two] = await Promise.all([first, second]);
  const items = [...completed(one).items, ...completed(two).items];
  assert.equal(items.length, SINGLE_CALL);
  assert.equal(items[0]?.kind, ActionResultKind.Submitted);
  assert.equal(h.creates(), SINGLE_CALL);
  assert.equal(h.gitHub.pulls.length, SINGLE_CALL);
  const evidence = completed(
    await h.call(missionOperations["evidence.list"], {
      params: { node_id: h.node_id },
      query: {},
      body: null,
    }),
  );
  assert.equal(
    evidence.items.filter((item) => item.requirement_key).length,
    SINGLE_CALL,
  );
  assert.deepEqual(completed(await h.request(DIRECT, key)), completed(one));
  assert.equal(h.creates(), SINGLE_CALL);
});

test("another registration fails the execution proof through both adapters", async (t) => {
  const h = await setup(t, HTTP);
  const other = await h.fixture.machineToken(h.project_id, "harness", "second");
  completed(await h.call(workerOperations.register, NO_INPUT, other));
  for (const adapter of [DIRECT, HTTP] as const)
    refused(
      await h.request(adapter, ulid(), other),
      HttpStatus.Forbidden,
      PROOF_FAILED,
    );
  assert.equal(h.gitHub.calls.length, NO_CALLS);
});

test("a GitHub refusal answers failed_before_effect and releases the reservation", async (t) => {
  const h = await setup(t, HTTP);
  h.gitHub.respondNext(UNPROCESSABLE_STATUS, { message: "Validation Failed" });
  for (let round = 0; round < TWO_REQUESTS; round++) {
    const [item] = completed(await h.request()).items;
    assert.ok(item?.kind === ActionResultKind.FailedBeforeEffect);
    assert.equal(item.refusal.class, RefusalClass.FinalRefusal);
    assert.equal(item.refusal.code, FINAL_REFUSAL_CODE);
  }
  assert.equal(h.creates(), SINGLE_CALL);
  assert.deepEqual(
    h.gitHub.calls.map((item) => item.method),
    [HttpMethod.Post, HttpMethod.Get],
  );
  assert.equal(h.gitHub.pulls.length, NO_CALLS);
});

test("a revoked credential refusal removes the reservation and a repeat reaches Intake", async (t) => {
  const h = await setup(t, HTTP);
  const authorize = t.mock.method(h.fixture.custody, "authorizeOperation");
  authorize.mock.mockImplementationOnce(() => {
    throw new OperationError(HttpStatus.Conflict, REVOKED_CODE, "revoked");
  });
  refused(await h.request(), HttpStatus.Conflict, REVOKED_CODE);
  assert.equal(h.creates(), NO_CALLS);
  const [item] = completed(await h.request()).items;
  assert.equal(item?.kind, ActionResultKind.Submitted);
  assert.equal(authorize.mock.callCount(), TWO_REQUESTS);
  assert.equal(h.creates(), SINGLE_CALL);
});

test("action operation keeps the long unary execution-scoped contract", () => {
  const operation = workerOperations["action.request"];
  assert.equal(operation.timeoutMs, ACTION_REQUEST_TIMEOUT_MS);
  assert.equal(operation.lifetime, OperationLifetime.Unary);
  assert.equal(operation.requiresExecution, true);
});
