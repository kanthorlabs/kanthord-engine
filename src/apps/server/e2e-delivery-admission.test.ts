import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  ActorKind,
  ActorService,
  AdmissionRefusal,
  AssessmentResult,
  AssetKind,
  Disposition,
  NodeState,
  Resolution,
  missionOperations,
  type Evidence,
  type Revision,
} from "../../mission/contract.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import { ActionResultKind, workerOperations } from "../../worker/contract.ts";
import {
  FAKE_SSH_CREDENTIAL_BODY,
  FAKE_SSH_IDENTITY,
  bareRepository,
  fakeGitHub,
  gatewayFixture,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import { environment, generateMachineToken, kanthord } from "./cli-support.ts";

const INITIAL_SEQUENCE = 0;
const SUCCESSFUL_EXIT = 0;
const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_ITEM = 1;
const FIRST_PULL_REQUEST = 1;
const UNMATCHED_PULL_REQUEST = 9;
const ISSUE_NUMBER = 3;
const BAD_GATEWAY_STATUS = 502;
const NO_OUTPUT = "";
const TIMEOUT = 300000;
const SECRET = "test-secret";
const GATED = "gated";
const GATED_RESOURCE = "repository:github:owner/gated";
const RESOURCE = "owner/gated";
const MERGED_COMMIT = "e".repeat(40);
const RETRYABLE_REFUSAL = "repository.platform.github.retryable_refusal";
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };
type Check = { results: { resolution: string }[]; failures: unknown[] };
type Webhook = { event: string; payload: unknown };

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.equal(result.status, HttpStatus.OK);
  return result.data;
}

function issue(): Webhook {
  return {
    event: "issues",
    payload: {
      action: "opened",
      issue: { number: ISSUE_NUMBER },
      repository: { full_name: RESOURCE },
    },
  };
}

function closed(number: number, merged: boolean): Webhook {
  return {
    event: "pull_request",
    payload: {
      action: "closed",
      number,
      pull_request: { merged },
      repository: { full_name: RESOURCE },
    },
  };
}

async function pushNodeBranch(
  t: TestContext,
  bare: string,
  nodeId: string,
  content: string,
) {
  const directory = join(temporary(t), "node");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Node");
  await git.addConfig("user.email", "test_node@example.invalid");
  await git.raw(["checkout", "-b", `kanthord/${nodeId}`]);
  writeFileSync(join(directory, "node.md"), content);
  await git.add("node.md");
  await git.commit(content);
  await git.push("origin", `kanthord/${nodeId}`);
  const head = (await git.revparse(["HEAD"])).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(await remoteHead(bare, `refs/heads/kanthord/${nodeId}`), head);
  return head;
}

async function cli(t: TestContext) {
  const gitHub = await fakeGitHub(t);
  const gatedBare = await bareRepository(t, GATED);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
    repositoryTransport: mappedTransport({
      [`git@github.com:owner/${GATED}.git`]: gatedBare.bare,
    }),
  });
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const secrets = [SECRET, fixture.token];
  let sequence = INITIAL_SEQUENCE;
  const file = (body: unknown) => {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[], env = H): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESSFUL_EXIT, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    for (const secret of secrets) assert.ok(!result.stdout.includes(secret));
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, env = H) =>
    read<T>([...args, "--file", file(body)], env);
  return { t, gitHub, gatedBare, fixture, H, secrets, read, write };
}

type Cli = Awaited<ReturnType<typeof cli>>;

async function project(c: Cli) {
  await c.write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: SECRET },
  });
  await c.write(
    ["repository", "credential", "create"],
    FAKE_SSH_CREDENTIAL_BODY,
  );
  const created = await c.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "admission",
  ]);
  const mission = await c.read<{ id: string }>(["mission", "get", created.id]);
  await c.write(["project", "binding", "apply", created.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: `git@github.com:owner/${GATED}.git`,
          strategy: {
            base_branch: "main",
            action: {
              name: "pull_request",
              follows: { type: "assessment_passed" },
            },
          },
          ssh_credential: FAKE_SSH_CREDENTIAL_BODY.name,
          credential: "github",
        },
      },
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
      },
    },
  });
  const bindings = await c.read<Page<Binding>>([
    "project",
    "binding",
    "list",
    created.id,
  ]);
  const binding = (name: string) =>
    bindings.items.find((item) => item.name === name)!;
  assert.equal(binding(GATED).resource_identity, GATED_RESOURCE);
  return { projectId: created.id, missionId: mission.id, binding };
}

async function setup(t: TestContext) {
  const c = await cli(t);
  const { projectId, missionId, binding } = await project(c);
  const missionVersion = async () =>
    (await c.read<{ version: number }>(["mission", "get", projectId])).version;
  const create = async (filename: string, parentId?: string) => {
    const result = await c.write<{ revisions: Revision[] }>(
      ["mission", "node", "create", missionId],
      {
        filename,
        kind: parentId ? "objective" : "initiative",
        content: {
          ...CONTENT,
          bindings: parentId ? [binding(GATED).id] : [],
        },
        reason: "plan",
        expected_mission_version: await missionVersion(),
        ...(parentId
          ? { parent_id: parentId, expected_parent_revision: FIRST_REVISION }
          : {}),
      },
    );
    return result.revisions[FIRST_INDEX]!.node_id;
  };
  const token = generateMachineToken({
    env: c.H,
    masterKey: c.fixture.config.master_key,
    projectId,
    bindingName: "harness",
    name: "Harness",
  }).token;
  c.secrets.push(token);
  const T = { ...c.H, KANTHORD_TOKEN: token };
  const { runtime_identity: rid } = await c.read<{ runtime_identity: string }>(
    ["worker", "register"],
    T,
  );
  const node = (nodeId: string) =>
    c.read<{ state: string }>(["mission", "node", "get", nodeId]);
  const pull = async (nodeId: string, state: string) => {
    const result = await c.write<{ kind: string; execution: ExecutionRecord }>(
      ["scheduler", "work", "pull"],
      {
        resource_identity: binding("harness").resource_identity,
        runtime_identity: rid,
      },
      T,
    );
    assert.equal(result.kind, WorkPullKind.Claimed);
    assert.equal(result.execution.node_id, nodeId);
    assert.equal(result.execution.attempt, FIRST_ATTEMPT);
    assert.equal((await node(nodeId)).state, state);
    return result.execution;
  };
  const ctx = (execution: ExecutionRecord) => ({
    execution_id: execution.execution_id,
    attempt: FIRST_ATTEMPT,
    node_revision: execution.pinned_revision,
  });
  const snapshot = (commit: string) => ({
    kind: "repository",
    binding_id: binding(GATED).id,
    commit,
  });
  const release = (executionId: string) =>
    c.write<{ ended_at: number }>(
      ["scheduler", "execution", "release", executionId],
      { further_work: false },
      T,
    );
  const passingEvaluation = async (nodeId: string, commit: string) => {
    const x1 = await pull(nodeId, NodeState.Executing);
    const w1 = await c.write<{ evidence: Evidence }>(
      ["mission", "evidence", "submit", nodeId],
      {
        ...ctx(x1),
        subject: "head commit",
        assets: [{ kind: "repository", address: snapshot(commit) }],
      },
      T,
    );
    await release(x1.execution_id);
    const x2 = await pull(nodeId, NodeState.Evaluating);
    const r1 = await c.write<{ evidence: Evidence }>(
      ["mission", "evidence", "submit", nodeId],
      {
        ...ctx(x2),
        subject: "verification run",
        assets: [
          {
            kind: "produced",
            content: {
              media_type: "text/plain",
              encoding: "base64",
              data: "b2s=",
            },
          },
        ],
        verification: {
          tested_input: snapshot(commit),
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
      T,
    );
    const assessment = await c.write<{ assessment: { result: string } }>(
      ["mission", "assessment", "submit", nodeId],
      {
        ...ctx(x2),
        evidence_ids: [r1.evidence.id, w1.evidence.id],
        child_outcome_ids: [],
        result: "success",
        rationale: "verified",
        tested_input: snapshot(commit),
      },
      T,
    );
    assert.equal(assessment.assessment.result, AssessmentResult.Success);
    return x2;
  };
  const objective = async (filename: string, parentId: string) => {
    const nodeId = await create(filename, parentId);
    const head = await pushNodeBranch(
      c.t,
      c.gatedBare.bare,
      nodeId,
      `${filename}\n`,
    );
    return { nodeId, x2: await passingEvaluation(nodeId, head) };
  };
  const performer = httpClient(workerOperations, c.fixture.endpoint, token);
  const actionRequest = async (x: ExecutionRecord) =>
    completed(
      await performer["action.request"](
        { params: { execution_id: x.execution_id }, query: {}, body: null },
        { idempotencyKey: ulid() },
      ),
    );
  const check = async (nodeId: string) =>
    c.write<Check>(["mission", "node", "check", nodeId], {
      expected_mission_version: await missionVersion(),
    });
  const mission = directClient(missionOperations, c.fixture.invocation);
  const admit = (
    webhook: Webhook,
    inboundEventId: string,
    service = INTAKE_SERVICE_NAME,
  ) =>
    mission["delivery.admit"](
      {
        params: {},
        query: {},
        body: {
          inbound_event_id: inboundEventId,
          project_id: projectId,
          platform: "github",
          resource: RESOURCE,
          event: Buffer.from(JSON.stringify(webhook.payload)).toString(
            "base64",
          ),
          metadata: { event: webhook.event },
        },
      },
      { identity: mintServiceIdentity(service), idempotencyKey: ulid() },
    );
  return {
    ...c,
    create,
    objective,
    node,
    release,
    actionRequest,
    check,
    admit,
  };
}

test("E08 delivery admission journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  const I = await h.create("initiative-1.md");
  const P = await h.objective("objective-p.md", I);
  const action = await h.actionRequest(P.x2);
  assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
  await h.release(P.x2.execution_id);
  assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  const check = await h.check(P.nodeId);
  assert.equal(check.results[FIRST_INDEX]?.resolution, Resolution.Unresolved);

  await t.test("E08.1 an issue event is undecodable", async () => {
    const answer = completed(
      await h.admit(issue(), createIdentity("inbound_event")),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Undecodable,
    });
  });
  await t.test("E08.2 an unknown pull request is unmatched", async () => {
    const answer = completed(
      await h.admit(
        closed(UNMATCHED_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Unmatched,
    });
  });
  await t.test("E08.3 a failed platform read fails the admission", async () => {
    h.gitHub.failPulls(BAD_GATEWAY_STATUS);
    const result = await h.admit(
      closed(FIRST_PULL_REQUEST, true),
      createIdentity("inbound_event"),
    );
    h.gitHub.failPulls(null);
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.error.error.code, RETRYABLE_REFUSAL);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  });
  await t.test("E08.4 a merged pull request completes P", async () => {
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const i4 = createIdentity("inbound_event");
    const answer = completed(
      await h.admit(closed(FIRST_PULL_REQUEST, true), i4),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
    const evidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      P.nodeId,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const landed = evidence.items.filter(
      (item) => item.provenance.kind === ActorKind.Service,
    );
    assert.equal(landed.length, SINGLE_ITEM);
    assert.deepEqual(landed[FIRST_INDEX]!.provenance, {
      kind: ActorKind.Service,
      service: ActorService.Mission,
      inbound_event_id: i4,
    });
    const asset = landed[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);
  });
  await t.test("E08.5 a repeat event is a duplicate", async () => {
    const answer = completed(
      await h.admit(
        closed(FIRST_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Duplicate,
      reason: null,
    });
  });
});
