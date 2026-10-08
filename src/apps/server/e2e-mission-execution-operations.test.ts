import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { z } from "zod";
import { httpClient } from "../../gateway/client.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  ActorKind,
  ActorService,
  AssessmentResult,
  AssetKind,
  PlatformAddressKind,
  ClosingEvent,
  NodeState,
  Resolution,
  missionOperations,
  evidenceSubmitResultSchema,
  assessmentSubmitResultSchema,
  type Evidence,
  type Node,
  type Outcome,
  type Revision,
  type Attempt,
} from "../../mission/contract.ts";
import {
  ClaimState,
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  objectSink,
  sinkStorage,
  fakeGitHub,
} from "./test-support.ts";
import { environment, kanthord } from "./cli-support.ts";

const SUCCESSFUL_EXIT_CODE = 0;
const FIRST_ITEM_INDEX = 0;
const INVALID_REVISION_VALUE = 0;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const FAILED_EXIT_CODE = 1;
const SINGLE_ITEM_COUNT = 1;
const SECOND_MISSION_VERSION = 2;
const SECONDARY_PRIORITY = 2;
const ABOVE_PINNED_REVISION = 2;
const STALE_ATTEMPT_NUMBER = 2;
const PAIR_COUNT = 2;
const THIRD_MISSION_VERSION = 3;
const PRIMARY_PRIORITY = 3;
const POST_PLANNING_MISSION_VERSION = 4;
const TOTAL_EVIDENCE_COUNT = 4;
const OBJECT_SIZE_BYTES = 5;
const NO_OUTPUT = "";
const UNSET_ID = "";
const TEXT = "hello";
const MEDIA = "text/plain";
const NUMBER_TYPE = "number";
const WORKER = "claude@1";
const JOURNEY_TIMEOUT = 180000;
const REDIRECTION_STATUS = 300;
const COMMIT = "b".repeat(40);
const LANDED = "c".repeat(40);
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
};
const PASS = [
  {
    command: "true",
    exit_code: SUCCESSFUL_EXIT_CODE,
    signal: null,
    timed_out: false,
  },
];
type Page<T> = { items: T[]; next_cursor: string | null };
type Submission = z.infer<typeof evidenceSubmitResultSchema>;
type Assessment = z.infer<typeof assessmentSubmitResultSchema>;
type Pull = { kind: string; execution: ExecutionRecord };

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.ok(
    result.status >= HttpStatus.OK && result.status < REDIRECTION_STATUS,
  );
  return result.data;
}

async function setup(t: TestContext) {
  const sink = await objectSink(t);
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
    standIns: { intakeStorage: sinkStorage(sink) },
  });
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let sequence = FIRST_ITEM_INDEX;
  const file = (body: unknown) => {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[], env = H): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESSFUL_EXIT_CODE, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, env = H) =>
    read<T>([...args, "--file", file(body)], env);
  const refuses = async (args: string[], code: string, env = H) => {
    const result = await kanthord(args, env);
    assert.equal(result.code, FAILED_EXIT_CODE, result.stderr);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    assert.equal(result.stdout, NO_OUTPUT);
  };
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "execution",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  await write(["repository", "credential", "create"], {
    name: "github-ssh",
    platform: "ssh",
    metadata: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_rsa",
    },
    secret: {},
  });
  await write(["storage", "credential", "create"], {
    name: "store",
    platform: "s3",
    metadata: {
      endpoint: "https://s3.example.com",
      bucket: "evidence",
      region: "eu-central-1",
    },
    secret: {
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: "example-secret",
    },
  });
  const repository = (name: string, gated: boolean) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: `git@github.com:owner/${name}.git`,
      ssh_credential: "github-ssh",
      strategy: {
        base_branch: "main",
        ...(gated
          ? {
              action: {
                name: "pull_request",
                follows: { type: "assessment_passed" },
              },
            }
          : {}),
      },
      credential: "github",
    },
  });
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      repo: repository("repo", false),
      gated: repository("gated", true),
      store: {
        kind: "storage",
        config: {
          available: true,
          endpoint: "https://s3.example.com",
          bucket: "evidence",
          region: "eu-central-1",
          prefix: "kanthord",
          credential: "store",
        },
      },
      harness: {
        kind: "worker",
        config: { worker: WORKER, instance_count: SINGLE_ITEM_COUNT },
      },
    },
  });
  const bindings = await read<
    Page<{ id: string; name: string; resource_identity: string }>
  >(["project", "binding", "list", project.id]);
  const binding = (name: string) => {
    const row = bindings.items.find((item) => item.name === name);
    assert.ok(row);
    return row;
  };
  const create = async (
    filename: string,
    kind: string,
    names: string[],
    version: number,
    parentId?: string,
  ) => {
    const result = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        kind,
        content: {
          ...CONTENT,
          bindings: names.map((name) => binding(name).id),
        },
        reason: "plan",
        expected_mission_version: version,
        ...(parentId
          ? { parent_id: parentId, expected_parent_revision: FIRST_REVISION }
          : {}),
      },
    );
    return result.revisions[FIRST_ITEM_INDEX]!.node_id;
  };
  const initiative = await create(
    "initiative-1.md",
    "initiative",
    [],
    FIRST_REVISION,
  );
  const objectiveA = await create(
    "objective-a.md",
    "objective",
    ["repo", "store"],
    SECOND_MISSION_VERSION,
    initiative,
  );
  const objectiveB = await create(
    "objective-b.md",
    "objective",
    ["gated"],
    THIRD_MISSION_VERSION,
    initiative,
  );
  await write(["mission", "node", "priority", "set", objectiveA], {
    value: PRIMARY_PRIORITY,
    expected_mission_version: POST_PLANNING_MISSION_VERSION,
  });
  await write(["mission", "node", "priority", "set", objectiveB], {
    value: SECONDARY_PRIORITY,
    expected_mission_version: POST_PLANNING_MISSION_VERSION,
  });
  const machineToken = await fixture.machineToken(project.id, "harness");
  const W = { ...H, KANTHORD_TOKEN: machineToken };
  const registration = await read<{ runtime_identity: string }>(
    ["worker", "register"],
    W,
  );
  const pullBody = {
    resource_identity: binding("harness").resource_identity,
    runtime_identity: registration.runtime_identity,
  };
  const pull = () => write<Pull>(["scheduler", "work", "pull"], pullBody, W);
  const api = httpClient(missionOperations, fixture.endpoint, machineToken);
  assert.ok(initiative && objectiveA && objectiveB);
  assert.ok(binding("repo").id);
  return {
    sink,
    gitHub,
    read,
    write,
    refuses,
    file,
    H,
    W,
    api,
    binding,
    initiative,
    objectiveA,
    objectiveB,
    pull,
  };
}

test(
  "E04 Mission execution operations through CLI and host HTTP adapter",
  { timeout: JOURNEY_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    let e1 = UNSET_ID,
      e2 = UNSET_ID,
      e3 = UNSET_ID,
      e4 = UNSET_ID,
      e5 = UNSET_ID;
    let work!: Submission,
      object!: Submission,
      run!: Submission,
      failed!: Submission,
      gatedRun!: Submission;
    let request!: Evidence;
    let landedEvidenceId = UNSET_ID;
    let gatedOutcome!: Outcome;
    const ctx = (executionId: string) => ({
      execution_id: executionId,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_REVISION,
    });
    const address = (gated = false) => ({
      kind: AssetKind.Repository,
      binding_id: h.binding(gated ? "gated" : "repo").id,
      commit: COMMIT,
    });
    const workBody = (executionId: string, gated = false) => ({
      ...ctx(executionId),
      subject: "head commit",
      assets: [{ kind: AssetKind.Repository, address: address(gated) }],
    });
    const objectBody = () => ({
      ...ctx(e1),
      subject: "recording",
      assets: [
        { kind: AssetKind.Object, size: OBJECT_SIZE_BYTES, media_type: MEDIA },
      ],
    });
    const runBody = (
      executionId: string,
      gated = false,
      exitCode = SUCCESSFUL_EXIT_CODE,
    ) => ({
      ...ctx(executionId),
      subject: "verification run",
      assets: [
        {
          kind: AssetKind.Produced,
          content: { media_type: MEDIA, encoding: "base64", data: "b2s=" },
        },
      ],
      verification: {
        tested_input: address(gated),
        results: PASS.map((result) => ({ ...result, exit_code: exitCode })),
      },
    });
    const assessment = (
      executionId: string,
      evidenceIds: string[],
      gated = false,
    ) => ({
      ...ctx(executionId),
      evidence_ids: evidenceIds,
      child_outcome_ids: [],
      result: AssessmentResult.Success,
      rationale: "met",
      tested_input: address(gated),
    });
    const node = (nodeId: string) =>
      h.read<Node>(["mission", "node", "get", nodeId]);
    const release = (executionId: string) =>
      h.write(
        ["scheduler", "execution", "release", executionId],
        { further_work: false },
        h.W,
      );
    const badWrite = (args: string[], body: unknown, code: string, env = h.W) =>
      h.refuses([...args, "--file", h.file(body)], code, env);
    await t.test("E04.1 claim objective A", async () => {
      const answer = await h.pull();
      assert.equal(answer.kind, WorkPullKind.Claimed);
      assert.equal(answer.execution.node_id, h.objectiveA);
      assert.equal(answer.execution.attempt, FIRST_ATTEMPT);
      assert.equal(answer.execution.pinned_revision, FIRST_REVISION);
      e1 = answer.execution.execution_id;
    });
    await t.test("E04.2 pinned revision and above-pin refusal", async () => {
      const revision = await h.read<Revision>(
        ["mission", "execution", "pinned-revision", "get", e1],
        h.W,
      );
      assert.equal(revision.revision, FIRST_REVISION);
      assert.deepEqual(revision.content.verifications, ["true"]);
      await h.refuses(
        [
          "mission",
          "execution",
          "revision",
          "get",
          e1,
          String(ABOVE_PINNED_REVISION),
        ],
        "mission.execution.revision_above_pin",
        h.W,
      );
    });
    await t.test("E04.3 repository submission", async () => {
      work = await h.write<Submission>(
        ["mission", "evidence", "submit", h.objectiveA],
        workBody(e1),
        h.W,
      );
      assert.equal(work.evidence.provenance.kind, ActorKind.Execution);
      assert.ok("execution_id" in work.evidence.provenance);
      assert.equal(work.evidence.provenance.execution_id, e1);
      assert.equal(work.evidence.attempt, FIRST_ATTEMPT);
      assert.equal(
        typeof work.evidence.assets[FIRST_ITEM_INDEX]!.published_at,
        NUMBER_TYPE,
      );
      assert.deepEqual(work.uploads, []);
    });
    await t.test("E04.4 stale context", async () => {
      await badWrite(
        ["mission", "evidence", "submit", h.objectiveA],
        { ...workBody(e1), attempt: STALE_ATTEMPT_NUMBER },
        "mission.execution.context_mismatch",
      );
    });
    await t.test("E04.5 CLI object refusal", async () => {
      await badWrite(
        ["mission", "evidence", "submit", h.objectiveA],
        objectBody(),
        "cli.mission.evidence.submit.object_asset",
      );
    });
    await t.test("E04.6 host object submission", async () => {
      object = completed(
        await h.api["evidence.submit"]({
          params: { node_id: h.objectiveA },
          query: {},
          body: objectBody(),
        }),
      );
      assert.ok(
        object.uploads[FIRST_ITEM_INDEX]!.put_url.startsWith(h.sink.endpoint),
      );
      assert.equal(
        object.evidence.assets[FIRST_ITEM_INDEX]!.published_at,
        null,
      );
      assert.equal(
        typeof object.evidence.assets[FIRST_ITEM_INDEX]!.expired_at,
        NUMBER_TYPE,
      );
    });
    await t.test("E04.7 steps cannot assess", async () => {
      await badWrite(
        ["mission", "assessment", "submit", h.objectiveA],
        assessment(e1, [work.evidence.id]),
        "mission.execution.claim_not_evaluation",
      );
    });
    await t.test("E04.8 attempt evidence list", async () => {
      const page = await h.read<Page<Evidence>>(
        ["mission", "execution", "evidence", "list", e1],
        h.W,
      );
      assert.equal(page.items.length, PAIR_COUNT);
      assert.equal(page.next_cursor, null);
    });
    await t.test("E04.9 release to Waiting", async () => {
      await release(e1);
      const answer = await node(h.objectiveA);
      assert.ok("state" in answer);
      assert.equal(answer.state, NodeState.Waiting);
      assert.equal(answer.attempt, FIRST_ATTEMPT);
    });
    await t.test("E04.10 evaluation claim", async () => {
      const answer = await h.pull();
      assert.equal(answer.execution.node_id, h.objectiveA);
      assert.equal(answer.execution.attempt, FIRST_ATTEMPT);
      e2 = answer.execution.execution_id;
    });
    await t.test("E04.11 passing verification evidence", async () => {
      run = await h.write<Submission>(
        ["mission", "evidence", "submit", h.objectiveA],
        runBody(e2),
        h.W,
      );
      assert.equal(
        run.evidence.verification!.results[FIRST_ITEM_INDEX]!.exit_code,
        SUCCESSFUL_EXIT_CODE,
      );
    });
    await t.test("E04.12 failed verification refuses success", async () => {
      failed = await h.write<Submission>(
        ["mission", "evidence", "submit", h.objectiveA],
        runBody(e2, false, FAILED_EXIT_CODE),
        h.W,
      );
      await badWrite(
        ["mission", "assessment", "submit", h.objectiveA],
        assessment(e2, [failed.evidence.id]),
        "mission.assessment.verification_failed",
      );
    });
    await t.test("E04.13 pending evidence refusal", async () => {
      await badWrite(
        ["mission", "assessment", "submit", h.objectiveA],
        assessment(e2, [run.evidence.id, object.evidence.id]),
        "mission.assessment.evidence_unpublished",
      );
    });
    await t.test("E04.14 PUT and complete", async () => {
      const upload = object.uploads[FIRST_ITEM_INDEX]!;
      const put = await fetch(upload.put_url, {
        method: "PUT",
        headers: upload.headers,
        body: TEXT,
      });
      assert.equal(put.status, HttpStatus.OK);
      await put.arrayBuffer();
      const answer = completed(
        await h.api["evidence.asset.complete"]({
          params: { asset_id: upload.asset_id },
          query: {},
          body: ctx(e2),
        }),
      );
      assert.ok(answer.uri.startsWith("s3://evidence/kanthord/"));
      const evidence = await h.read<Evidence>([
        "mission",
        "evidence",
        "get",
        object.evidence.id,
      ]);
      assert.equal(
        typeof evidence.assets[FIRST_ITEM_INDEX]!.published_at,
        NUMBER_TYPE,
      );
    });
    await t.test(
      "E04.15 object read and execution URL suppression",
      async () => {
        const assetId = object.evidence.assets[FIRST_ITEM_INDEX]!.id;
        const answer = await h.read<{
          size: number;
          media_type: string;
          get_url: string;
        }>(["mission", "evidence", "asset", "content", "get", assetId]);
        assert.equal(answer.size, OBJECT_SIZE_BYTES);
        assert.equal(answer.media_type, MEDIA);
        const response = await fetch(answer.get_url);
        assert.equal(response.status, HttpStatus.OK);
        assert.equal(await response.text(), TEXT);
        await h.refuses(
          [
            "mission",
            "execution",
            "evidence",
            "asset",
            "content",
            "get",
            e2,
            assetId,
          ],
          "cli.mission.execution.evidence.asset.content.get.object_content",
          h.W,
        );
      },
    );
    await t.test("E04.16 repository content refusal", async () => {
      await h.refuses(
        [
          "mission",
          "evidence",
          "asset",
          "content",
          "get",
          work.evidence.assets[FIRST_ITEM_INDEX]!.id,
        ],
        "mission.evidence.content_repository",
      );
    });
    await t.test("E04.17 successful assessment closes A", async () => {
      const answer = await h.write<Assessment>(
        ["mission", "assessment", "submit", h.objectiveA],
        assessment(e2, [run.evidence.id, work.evidence.id]),
        h.W,
      );
      assert.equal(answer.assessment.actor.kind, ActorKind.Execution);
      assert.ok("currency" in answer.assessment);
      assert.ok(answer.assessment.currency?.current);
      assert.equal(answer.assessment.worker_version, WORKER);
      assert.ok("state" in answer.node);
      assert.equal(answer.node.state, NodeState.Completed);
      assert.equal(answer.outcome?.result, AssessmentResult.Success);
      assert.equal(
        answer.outcome?.closing_event,
        ClosingEvent.AssessmentPassed,
      );
      assert.equal(answer.outcome?.attempt, FIRST_ATTEMPT);
    });
    await t.test(
      "E04.18 finished claim rejects further execution acts",
      async () => {
        const claim = await h.read<{ claim_state: string }>(
          ["scheduler", "claim", "get", e2],
          h.W,
        );
        assert.equal(claim.claim_state, ClaimState.Finished);
        await badWrite(
          ["scheduler", "execution", "release", e2],
          { further_work: false },
          "gateway.invocation.execution_proof_failed",
        );
        await h.refuses(
          ["mission", "execution", "evidence", "list", e2],
          "gateway.invocation.execution_proof_failed",
          h.W,
        );
      },
    );
    await t.test("E04.19 human reads closed attempt records", async () => {
      const page = await h.read<Page<Evidence>>([
        "mission",
        "evidence",
        "list",
        h.objectiveA,
        "--attempt",
        String(FIRST_ATTEMPT),
      ]);
      assert.equal(page.items.length, TOTAL_EVIDENCE_COUNT);
      const attempt = await h.read<Attempt>([
        "mission",
        "attempt",
        "get",
        h.objectiveA,
        String(FIRST_ATTEMPT),
      ]);
      assert.equal(typeof attempt.closed_at, NUMBER_TYPE);
      assert.equal(attempt.outcome_ids.length, SINGLE_ITEM_COUNT);
    });
    await t.test("E04.20 forced delete validation and removal", async () => {
      const args = [
        "mission",
        "evidence",
        "delete",
        failed.evidence.id,
        "--expected-mission-version",
        String(POST_PLANNING_MISSION_VERSION),
      ];
      await h.refuses(args, "mission.evidence.remove_node_live");
      await h.refuses(
        [...args, "--force"],
        "gateway.request.validation_failed",
      );
      const answer = await h.read<{ idempotency_key: string }>([
        ...args,
        "--force",
        "--reason",
        "cleanup",
      ]);
      assert.ok(answer.idempotency_key);
      await h.refuses(
        ["mission", "evidence", "get", failed.evidence.id],
        "mission.record.not_found",
      );
    });
    await t.test("E04.21 work on gated objective B", async () => {
      const answer = await h.pull();
      assert.equal(answer.execution.node_id, h.objectiveB);
      e3 = answer.execution.execution_id;
      await h.write<Submission>(
        ["mission", "evidence", "submit", h.objectiveB],
        workBody(e3, true),
        h.W,
      );
      await release(e3);
    });
    await t.test("E04.22 gated pass keeps evaluation live", async () => {
      e4 = (await h.pull()).execution.execution_id;
      gatedRun = await h.write<Submission>(
        ["mission", "evidence", "submit", h.objectiveB],
        runBody(e4, true),
        h.W,
      );
      const answer = await h.write<Assessment>(
        ["mission", "assessment", "submit", h.objectiveB],
        assessment(e4, [gatedRun.evidence.id], true),
        h.W,
      );
      assert.ok("state" in answer.node);
      assert.equal(answer.node.state, NodeState.Evaluating);
      assert.equal(answer.outcome, null);
    });
    await t.test("E04.23 action request and duplicate refusal", async () => {
      const number = h.gitHub.open({
        owner: "owner",
        repo: "gated",
        head: `kanthord/${h.objectiveB}`,
        base: "main",
      });
      const body = {
        ...ctx(e4),
        requirement_key: "gated.pull_request",
        subject: `pull request ${number}`,
        address: {
          kind: "pull_request" as const,
          resource_identity: h.binding("gated").resource_identity,
          number,
        },
      };
      request = completed(
        await h.api["evidence.request"]({
          params: { node_id: h.objectiveB },
          query: {},
          body,
        }),
      );
      assert.equal(request.requirement_key, body.requirement_key);
      assert.equal(request.assets.length, SINGLE_ITEM_COUNT);
      assert.equal(request.assets[FIRST_ITEM_INDEX]!.kind, AssetKind.Platform);
      const duplicate = await h.api["evidence.request"]({
        params: { node_id: h.objectiveB },
        query: {},
        body,
      });
      assert.ok(duplicate.type === OperationResultType.Failure);
      assert.equal(duplicate.status, HttpStatus.Conflict);
      const code = "mission.request.already_requested";
      assert.equal(duplicate.error.error.code, code);
    });
    await t.test("E04.24 release to external wait", async () => {
      await release(e4);
      const page = await h.read<
        Page<{ resolution: string; request_evidence_id: string }>
      >([
        "mission",
        "external-action",
        "list",
        h.objectiveB,
        "--attempt",
        String(FIRST_ATTEMPT),
      ]);
      assert.equal(
        page.items[FIRST_ITEM_INDEX]!.resolution,
        Resolution.Unresolved,
      );
      assert.equal(
        page.items[FIRST_ITEM_INDEX]!.request_evidence_id,
        request.id,
      );
    });
    await t.test("E04.25 request content and deletion refusals", async () => {
      await h.refuses(
        [
          "mission",
          "evidence",
          "asset",
          "content",
          "get",
          request.assets[FIRST_ITEM_INDEX]!.id,
        ],
        "mission.evidence.content_platform",
      );
      await h.refuses(
        [
          "mission",
          "evidence",
          "asset",
          "delete",
          request.assets[FIRST_ITEM_INDEX]!.id,
          "--expected-mission-version",
          String(POST_PLANNING_MISSION_VERSION),
        ],
        "mission.evidence.request_asset_refused",
      );
      await h.refuses(
        [
          "mission",
          "evidence",
          "delete",
          request.id,
          "--expected-mission-version",
          String(POST_PLANNING_MISSION_VERSION),
        ],
        "mission.evidence.request_force_required",
      );
    });
    await t.test("E04.26 observed expected end closes B", async () => {
      const address = request.assets[FIRST_ITEM_INDEX]!;
      assert.ok(address.kind === AssetKind.Platform);
      assert.ok(address.address.kind === PlatformAddressKind.PullRequest);
      h.gitHub.merge(address.address.number, LANDED);
      const answer = await h.write<{
        results: { resolution: string }[];
        failures: unknown[];
      }>(["mission", "node", "check", h.objectiveB], {
        expected_mission_version: POST_PLANNING_MISSION_VERSION,
      });
      assert.equal(
        answer.results[FIRST_ITEM_INDEX]!.resolution,
        Resolution.ExpectedEnd,
      );
      assert.deepEqual(answer.failures, []);
      const current = await node(h.objectiveB);
      assert.ok("state" in current);
      assert.equal(current.state, NodeState.Completed);
      const outcomes = await h.read<Page<Outcome>>([
        "mission",
        "outcome",
        "list",
        h.objectiveB,
      ]);
      assert.equal(
        outcomes.items[FIRST_ITEM_INDEX]!.closing_event,
        ClosingEvent.ExternalSuccess,
      );
      assert.equal(
        outcomes.items[FIRST_ITEM_INDEX]!.evidence_ids.length,
        PAIR_COUNT,
      );
      gatedOutcome = outcomes.items[FIRST_ITEM_INDEX]!;
    });
    await t.test("E04.27 landed evidence and no unresolved check", async () => {
      const page = await h.read<Page<Evidence>>([
        "mission",
        "evidence",
        "list",
        h.objectiveB,
        "--attempt",
        String(FIRST_ATTEMPT),
      ]);
      const landed = page.items.filter(
        (item) =>
          item.provenance.kind === ActorKind.Service &&
          item.provenance.service === ActorService.Mission,
      );
      assert.equal(landed.length, SINGLE_ITEM_COUNT);
      landedEvidenceId = landed[FIRST_ITEM_INDEX]!.id;
      assert.deepEqual(
        [...gatedOutcome.evidence_ids].sort(),
        [gatedRun.evidence.id, landedEvidenceId].sort(),
      );
      const asset = landed[FIRST_ITEM_INDEX]!.assets[FIRST_ITEM_INDEX]!;
      assert.ok(asset.kind === AssetKind.Repository);
      assert.equal(asset.address.commit, LANDED);
      await badWrite(
        ["mission", "node", "check", h.objectiveB],
        { expected_mission_version: POST_PLANNING_MISSION_VERSION },
        "mission.node.no_unresolved_request",
        h.H,
      );
    });
    await t.test(
      "E04.28 initiative reads its outcome-pinned objective context",
      async () => {
        const answer = await h.pull();
        assert.equal(answer.execution.node_id, h.initiative);
        e5 = answer.execution.execution_id;
        const objectives = await h.read<Page<{ visible_revision: number }>>(
          ["mission", "execution", "objective", "list", e5],
          h.W,
        );
        assert.equal(objectives.items.length, PAIR_COUNT);
        assert.ok(
          objectives.items.every(
            (item) => item.visible_revision === FIRST_REVISION,
          ),
        );
        const outcomes = await h.read<Page<Outcome>>(
          ["mission", "execution", "objective", "outcome", "list", e5],
          h.W,
        );
        assert.equal(outcomes.items.length, PAIR_COUNT);
        const evidence = await h.read<Page<Evidence>>(
          ["mission", "execution", "objective", "evidence", "list", e5],
          h.W,
        );
        assert.equal(evidence.items.length, TOTAL_EVIDENCE_COUNT);
        assert.deepEqual(
          evidence.items.map((item) => item.id).sort(),
          [
            run.evidence.id,
            work.evidence.id,
            gatedRun.evidence.id,
            landedEvidenceId,
          ].sort(),
        );
        assert.ok(
          [run.evidence.id, work.evidence.id, gatedRun.evidence.id].every(
            (id) => evidence.items.some((item) => item.id === id),
          ),
        );
      },
    );
    await t.test("E04.29 first attempt has no cleared outcome", async () => {
      await h.refuses(
        ["mission", "execution", "cleared-outcome", "get", e5],
        "mission.record.not_found",
        h.W,
      );
    });
    await t.test("E04.30 local identity and numeric validation", async () => {
      await h.refuses(
        ["mission", "evidence", "get", "invalid"],
        "cli.mission.evidence.get.invalid_evidence_id",
      );
      await h.refuses(
        [
          "mission",
          "execution",
          "revision",
          "get",
          e5,
          String(INVALID_REVISION_VALUE),
        ],
        "cli.mission.execution.revision.get.invalid_revision",
        h.W,
      );
      await h.refuses(
        [
          "mission",
          "evidence",
          "delete",
          run.evidence.id,
          "--expected-mission-version",
          String(INVALID_REVISION_VALUE),
        ],
        "cli.mission.evidence.delete.invalid_expected_mission_version",
      );
    });
  },
);
