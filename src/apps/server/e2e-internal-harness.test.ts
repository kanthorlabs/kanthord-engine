import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  REPOSITORY_ADDRESS,
  GATED_ADDRESS,
  GITHUB_KEY,
  PROVIDER_KEY,
  JOURNEY_TIMEOUT_MS,
  journeyClient,
  createJourneyNode,
} from "./journey-support.ts";
import { generateMachineToken } from "./cli-support.ts";
import {
  gatewayFixture,
  objectSink,
  FAKE_SSH_IDENTITY,
  sinkStorage,
  fakeGitHub,
  scriptedActions,
  inProcessWorker,
  bareRepository,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/test-support.ts";
import {
  AssetKind,
  NodeState,
  AssessmentResult,
  ClosingEvent,
  type Evidence,
  type Assessment,
  type Outcome,
} from "../../mission/contract.ts";
import {
  ClaimState,
  WORK_PULL_WAIT_MS,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";

const GIT_TIMEOUT_MS = 10000;
const MAIN_REF = "refs/heads/main";
const TEST_BRANCH = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const SINGLE_INSTANCE = 1;
const INITIAL_BINDING_VERSION = 1;
const SINGLE_ITEM = 1;
const TWO_ITEMS = 2;
const EXPECTED_EVIDENCE_COUNT = 3;
const EXPECTED_REVIEW_CALLS = 3;
const EXPECTED_GENERAL_CALLS = 8;
const FILE_SIZE = 5;
const POLL_MS = 250;
const POLL_DEADLINE_MS = 60000;
const POLL_LIMIT = POLL_DEADLINE_MS / POLL_MS;
const READY = "Worker application ready";
const GENERAL = "general@1";
const REVIEWER = "reviewer@1";
const FILE_NAME = "hello.txt";
const MEDIA_TYPE = "application/octet-stream";
const MARKDOWN = "text/markdown";
const REPORT = "A and C are complete.";
const REQUIREMENT = "gated.pull_request";
const UNRESOLVED = "unresolved";
const EXPECTED_END = "expected-end";
const LANDED_COMMIT = "c".repeat(40);
const TOOL_RESULT = "toolResult";
const UPLOAD = "evidence-upload";
const DEFAULTS = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
};
const JUDGED =
  'kanthord-judgement: {"criterion_met":true,"rationale":"hello.txt holds hello"}';
const PASSED =
  'kanthord-judgement: {"result":"success","rationale":"hello.txt exists and holds hello; task met."}';
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
type Page<T> = { items: T[] };
type CLI = ReturnType<typeof journeyClient>;

async function waitForNode(cli: CLI, nodeId: string, state: string) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  for (
    let attempt = 0;
    attempt < POLL_LIMIT && Date.now() < deadline;
    attempt++
  ) {
    const node = await cli.read<{ state: string }>([
      "mission",
      "node",
      "get",
      nodeId,
    ]);
    if (node.state === state) {
      assert.ok(nodeId);
      assert.equal(node.state, state);
      return;
    }
    await delay(POLL_MS);
  }
  throw new Error(`Node ${nodeId} did not reach ${state}`);
}

async function setupInternal(t: TestContext) {
  const sink = await objectSink(t);
  const actions = scriptedActions();
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
    standIns: {
      intakeStorage: sinkStorage(sink),
      intakeActions: actions.seam,
    },
  });
  const cli = journeyClient(t, fixture.endpoint, fixture.token);
  for (const [group, name, platform, key] of [
    ["llm", "anthro-1", "anthropic", PROVIDER_KEY],
    ["repository", "github", "github", GITHUB_KEY],
  ] as const)
    await cli.write([group, "credential", "create"], {
      name,
      platform,
      metadata: null,
      secret: { key },
    });
  await cli.write(["repository", "credential", "create"], {
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
  const storage = {
    endpoint: "https://s3.example.com",
    bucket: "evidence",
    region: "eu-central-1",
  };
  await cli.write(["storage", "credential", "create"], {
    name: "store",
    platform: "s3",
    metadata: storage,
    secret: {
      access_key_id: "test_journey_access",
      secret_access_key: "test_journey_secret",
    },
  });
  cli.secrets.push("test_journey_access", "test_journey_secret");
  for (const agent of ["swe@1", "re@1"])
    await cli.write(["agent", "enablement", "put", agent], {
      agent_providers: [
        { name: "default", provider: "anthropic", credential: "anthro-1" },
      ],
      default_configuration: DEFAULTS,
    });
  const project = await cli.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "journey",
  ]);
  const repository = (address: string, gated = false) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address,
      ssh_credential: "github-ssh",
      credential: "github",
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
    },
  });
  const worker = (name: string, agent: string) => ({
    kind: "worker",
    config: {
      worker: name,
      instance_count: SINGLE_INSTANCE,
      entries: [{ agent, ...DEFAULTS }],
    },
  });
  const bindingSet = await cli.write<{
    bindings: Record<string, { id: string; resource_identity: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: INITIAL_BINDING_VERSION,
    bindings: {
      repo: repository(REPOSITORY_ADDRESS),
      gated: repository(GATED_ADDRESS, true),
      store: {
        kind: "storage",
        config: {
          available: true,
          ...storage,
          prefix: "kanthord",
          credential: "store",
        },
      },
      general: worker(GENERAL, "swe@1"),
      review: worker(REVIEWER, "re@1"),
    },
  });
  const initiative = await createJourneyNode(
    cli,
    project.id,
    "initiative-1.md",
    "initiative",
    [],
  );
  const objective = await createJourneyNode(
    cli,
    project.id,
    "objective-a.md",
    "objective",
    [bindingSet.bindings.repo!.id, bindingSet.bindings.store!.id],
    initiative,
  );
  await createJourneyNode(cli, project.id, "task-a.md", "task", [], objective);
  const gated = await createJourneyNode(
    cli,
    project.id,
    "objective-c.md",
    "objective",
    [bindingSet.bindings.gated!.id],
    initiative,
  );
  await createJourneyNode(cli, project.id, "task-c.md", "task", [], gated);
  for (const [nodeId, value] of [
    [objective, 5],
    [gated, 4],
  ] as const) {
    const mission = await cli.read<{ version: number }>([
      "mission",
      "get",
      project.id,
    ]);
    await cli.write(["mission", "node", "priority", "set", nodeId], {
      value,
      expected_mission_version: mission.version,
    });
  }
  const issue = (bindingName: string) =>
    generateMachineToken({
      env: cli.human,
      masterKey: fixture.config.master_key,
      projectId: project.id,
      bindingName,
      name: `test_${bindingName}`,
    });
  const generalAuth = issue("general");
  const reviewAuth = issue("review");
  cli.secrets.push(
    generalAuth.token,
    generalAuth.client_secret,
    reviewAuth.token,
    reviewAuth.client_secret,
  );
  assert.ok(bindingSet.bindings.repo && bindingSet.bindings.gated);
  assert.ok(objective && gated && initiative);
  return {
    fixture,
    cli,
    project_id: project.id,
    bindings: bindingSet.bindings,
    objective,
    gated,
    initiative,
    generalAuth,
    reviewAuth,
    sink,
    actions,
    gitHub,
  };
}

async function finishedExecutions(
  cli: CLI,
  projectId: string,
  nodeId: string,
  runtimes: string[],
) {
  const page = await cli.read<Page<ExecutionRecord>>([
    "scheduler",
    "execution",
    "list",
    projectId,
    "--node",
    nodeId,
  ]);
  assert.equal(page.items.length, TWO_ITEMS);
  assert.ok(
    page.items.every((item) => item.claim_state === ClaimState.Finished),
  );
  assert.deepEqual(
    page.items.map((item) => item.claimant.runtime_identity),
    runtimes,
  );
}

test(
  "EI10.1–7 internal harness completes local work, verification and external action",
  { timeout: JOURNEY_TIMEOUT_MS + WORK_PULL_WAIT_MS },
  async (t) => {
    const f = await setupInternal(t);
    const repo = await bareRepository(t, "test_repo");
    const gatedRepo = await bareRepository(t, "test_gated");
    const transport = mappedTransport({
      [REPOSITORY_ADDRESS]: repo.bare,
      [GATED_ADDRESS]: gatedRepo.bare,
    });
    const pr = {
      kind: "pull_request" as const,
      resource_identity: f.bindings.gated!.resource_identity,
      number: f.gitHub.open({
        owner: "owner",
        repo: "gated",
        head: `kanthord/${f.gated}`,
        base: "main",
      }),
    };
    f.actions.performAnswers.push(pr);
    const generalProvider = scriptedProvider([
      tool("bash", { command: "printf hello > hello.txt" }),
      tool(UPLOAD, { path: FILE_NAME }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage(JUDGED),
      tool("bash", { command: "printf hello > hello.txt" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage(JUDGED),
      fauxAssistantMessage(REPORT),
    ]);
    const reviewProvider = scriptedProvider([
      fauxAssistantMessage(PASSED),
      fauxAssistantMessage(PASSED),
      fauxAssistantMessage(PASSED),
    ]);
    const general = await inProcessWorker(t, {
      endpoint: f.fixture.endpoint,
      ...f.generalAuth,
      modelRuntimeFactory: scriptedModelRuntime(generalProvider),
      repositoryTransport: transport,
    });
    const review = await inProcessWorker(t, {
      endpoint: f.fixture.endpoint,
      ...f.reviewAuth,
      modelRuntimeFactory: scriptedModelRuntime(reviewProvider),
      repositoryTransport: transport,
    });
    const readyG = general.logs.find((line) => line.msg === READY)!;
    const readyR = review.logs.find((line) => line.msg === READY)!;
    const runtimes = [
      String(readyR.runtime_identity),
      String(readyG.runtime_identity),
    ];
    await t.test(
      "EI10.1 both workers register with their own binding",
      async () => {
        assert.equal(readyG.worker_name, GENERAL);
        assert.equal(readyR.worker_name, REVIEWER);
        assert.equal(
          readyG.resource_identity,
          f.bindings.general!.resource_identity,
        );
        assert.equal(
          readyR.resource_identity,
          f.bindings.review!.resource_identity,
        );
        const page = await f.cli.read<
          Page<{ runtime_identity: string; registered: boolean }>
        >(["worker", "instance", "list", "--project", f.project_id]);
        assert.deepEqual(
          page.items.map((item) => item.runtime_identity).sort(),
          [...runtimes].sort(),
        );
        assert.ok(page.items.every((item) => item.registered));
      },
    );
    let outcomeA!: string;
    await t.test(
      "EI10.2 objective publishes object and checkpoint, reviewer verifies",
      async () => {
        await waitForNode(f.cli, f.objective, NodeState.Completed);
        await finishedExecutions(f.cli, f.project_id, f.objective, runtimes);
        const evidence = await f.cli.read<Page<Evidence>>([
          "mission",
          "evidence",
          "list",
          f.objective,
          "--attempt",
          "1",
        ]);
        assert.equal(evidence.items.length, EXPECTED_EVIDENCE_COUNT);
        const uploaded = evidence.items.find(
          (item) => item.subject === FILE_NAME,
        )!;
        const asset = uploaded.assets[0]!;
        assert.ok(asset.kind === AssetKind.Object);
        assert.equal(asset.size, FILE_SIZE);
        assert.equal(asset.media_type, MEDIA_TYPE);
        assert.ok(Number.isFinite(asset.published_at));
        const head = await remoteHead(
          repo.bare,
          `refs/heads/kanthord/${f.objective}`,
        );
        assert.ok(head);
        const work = evidence.items.find((item) =>
          item.assets.some((asset) => asset.kind === AssetKind.Repository),
        )!;
        const workAsset = work.assets[0]!;
        assert.ok(workAsset.kind === AssetKind.Repository);
        assert.deepEqual(workAsset.address, {
          kind: AssetKind.Repository,
          binding_id: f.bindings.repo!.id,
          commit: head,
        });
        const verification = evidence.items.find((item) => item.verification)!;
        assert.deepEqual(
          verification.verification!.results.map(
            ({ command, exit_code: exitCode }) => ({
              command,
              exit_code: exitCode,
            }),
          ),
          [
            { command: "test -f hello.txt", exit_code: 0 },
            { command: "grep -q hello hello.txt", exit_code: 0 },
          ],
        );
        assert.deepEqual(verification.verification!.tested_input, {
          kind: "repository",
          binding_id: f.bindings.repo!.id,
          commit: head,
        });
        const assessments = await f.cli.read<Page<Assessment>>([
          "mission",
          "assessment",
          "list",
          f.objective,
        ]);
        assert.equal(assessments.items.length, SINGLE_ITEM);
        assert.equal(assessments.items[0]!.result, AssessmentResult.Success);
        assert.equal(assessments.items[0]!.worker_version, REVIEWER);
        assert.deepEqual(
          [...assessments.items[0]!.evidence_ids].sort(),
          [uploaded.id, work.id, verification.id].sort(),
        );
        const outcomes = await f.cli.read<Page<Outcome>>([
          "mission",
          "outcome",
          "list",
          f.objective,
        ]);
        assert.equal(outcomes.items.length, SINGLE_ITEM);
        assert.equal(outcomes.items[0]!.result, AssessmentResult.Success);
        assert.equal(
          outcomes.items[0]!.closing_event,
          ClosingEvent.AssessmentPassed,
        );
        outcomeA = outcomes.items[0]!.id;
        assert.equal(await remoteHead(repo.bare, MAIN_REF), repo.head);
      },
    );
    await t.test(
      "EI10.3 gated objective requests its configured action once",
      async () => {
        await waitForNode(f.cli, f.gated, NodeState.ExternalRequested);
        const head = await remoteHead(
          gatedRepo.bare,
          `refs/heads/kanthord/${f.gated}`,
        );
        assert.ok(head);
        const evidence = await f.cli.read<Page<Evidence>>([
          "mission",
          "evidence",
          "list",
          f.gated,
          "--attempt",
          "1",
        ]);
        assert.equal(evidence.items.length, EXPECTED_EVIDENCE_COUNT);
        const work = evidence.items
          .flatMap((item) => item.assets)
          .find((asset) => asset.kind === AssetKind.Repository)!;
        assert.ok(work.kind === AssetKind.Repository);
        assert.deepEqual(work.address, {
          kind: AssetKind.Repository,
          binding_id: f.bindings.gated!.id,
          commit: head,
        });
        assert.ok(evidence.items.some((item) => item.verification));
        const request = evidence.items.find(
          (item) => item.requirement_key === REQUIREMENT,
        )!;
        const asset = request.assets[0]!;
        assert.ok(asset.kind === AssetKind.Platform);
        assert.deepEqual(asset.address, pr);
        const actions = await f.cli.read<Page<{ resolution: string }>>([
          "mission",
          "external-action",
          "list",
          f.gated,
          "--attempt",
          "1",
        ]);
        assert.equal(actions.items[0]!.resolution, UNRESOLVED);
        assert.equal(f.actions.performCalls.length, SINGLE_ITEM);
        assert.deepEqual(f.actions.performCalls[0]!.operands, {
          nodeBranch: `kanthord/${f.gated}`,
          baseBranch: "main",
          commit: head,
          reusedAddress: null,
        });
      },
    );
    let outcomeC!: string;
    await t.test(
      "EI10.4 on-demand Intake check closes the external request",
      async () => {
        f.gitHub.merge(pr.number, LANDED_COMMIT);
        const mission = await f.cli.read<{ version: number }>([
          "mission",
          "get",
          f.project_id,
        ]);
        const checked = await f.cli.write<{
          results: { resolution: string }[];
        }>(["mission", "node", "check", f.gated], {
          expected_mission_version: mission.version,
        });
        assert.equal(checked.results[0]!.resolution, EXPECTED_END);
        const outcomes = await f.cli.read<Page<Outcome>>([
          "mission",
          "outcome",
          "list",
          f.gated,
        ]);
        assert.equal(
          outcomes.items[0]!.closing_event,
          ClosingEvent.ExternalSuccess,
        );
        outcomeC = outcomes.items[0]!.id;
        assert.deepEqual(
          f.gitHub.calls.map(({ method, path, token }) => ({
            method,
            path,
            token,
          })),
          [
            {
              method: "GET",
              path: `/repos/owner/gated/pulls/${pr.number}`,
              token: GITHUB_KEY,
            },
          ],
        );
      },
    );
    await t.test(
      "EI10.5 initiative report and assessment reference both current outcomes",
      async () => {
        await waitForNode(f.cli, f.initiative, NodeState.Completed);
        await finishedExecutions(f.cli, f.project_id, f.initiative, runtimes);
        const evidence = await f.cli.read<Page<Evidence>>([
          "mission",
          "evidence",
          "list",
          f.initiative,
          "--attempt",
          "1",
        ]);
        assert.equal(evidence.items.length, TWO_ITEMS);
        const report = evidence.items.find((item) => !item.verification)!;
        const asset = report.assets[0]!;
        assert.ok(asset.kind === AssetKind.Produced);
        const content = await f.cli.read<{ data: string; media_type: string }>([
          "mission",
          "evidence",
          "asset",
          "content",
          "get",
          asset.id,
        ]);
        assert.equal(content.media_type, MARKDOWN);
        assert.equal(Buffer.from(content.data, "base64").toString(), REPORT);
        const verification = evidence.items.find(
          (item) => item.verification,
        )!.verification!;
        assert.deepEqual(
          verification.results.map(({ command, exit_code: exitCode }) => ({
            command,
            exit_code: exitCode,
          })),
          [{ command: "true", exit_code: 0 }],
        );
        assert.ok(Array.isArray(verification.tested_input));
        assert.deepEqual(
          [...verification.tested_input].sort((a, b) =>
            a.binding_id.localeCompare(b.binding_id),
          ),
          [
            {
              kind: "repository",
              binding_id: f.bindings.repo!.id,
              commit: repo.head,
            },
            {
              kind: "repository",
              binding_id: f.bindings.gated!.id,
              commit: gatedRepo.head,
            },
          ].sort((a, b) => a.binding_id.localeCompare(b.binding_id)),
        );
        const assessments = await f.cli.read<Page<Assessment>>([
          "mission",
          "assessment",
          "list",
          f.initiative,
        ]);
        assert.equal(assessments.items.length, SINGLE_ITEM);
        assert.equal(assessments.items[0]!.result, AssessmentResult.Success);
        assert.deepEqual(
          [...assessments.items[0]!.child_outcome_ids].sort(),
          [outcomeA, outcomeC].sort(),
        );
      },
    );
    await t.test(
      "EI10.6 scripted inference sees credentials but messages and logs expose no secrets",
      () => {
        assert.equal(generalProvider.calls.length, EXPECTED_GENERAL_CALLS);
        assert.equal(reviewProvider.calls.length, EXPECTED_REVIEW_CALLS);
        const calls = [...generalProvider.calls, ...reviewProvider.calls];
        assert.ok(calls.every((call) => call.apiKey === PROVIDER_KEY));
        const messages = calls.flatMap((call) => call.messages);
        const result = messages.find(
          (message) =>
            message.role === TOOL_RESULT && message.toolName === UPLOAD,
        );
        assert.ok(result && result.role === TOOL_RESULT && !result.isError);
        assert.deepEqual(Object.keys(result.details as object).sort(), [
          "asset_id",
          "evidence_id",
          "uri",
        ]);
        assert.match(
          (result.details as { uri: string }).uri,
          /^s3:\/\/evidence\/kanthord\//,
        );
        const text = JSON.stringify(messages);
        for (const privateValue of [
          "put_url",
          f.sink.endpoint,
          "X-Amz",
          ...f.cli.secrets,
        ])
          assert.ok(!text.includes(privateValue));
        const logs = JSON.stringify([...general.logs, ...review.logs]);
        assert.ok(f.cli.secrets.every((secret) => !logs.includes(secret)));
      },
    );
    await t.test(
      "EI10.7 idle shutdown deregisters both instances with an empty queue",
      { timeout: JOURNEY_TIMEOUT_MS },
      async () => {
        assert.deepEqual(
          await Promise.all([general.worker.stop(), review.worker.stop()]),
          [null, null],
        );
        assert.equal(await general.running, null);
        assert.equal(await review.running, null);
        assert.deepEqual(
          (
            await f.cli.read<Page<unknown>>([
              "worker",
              "instance",
              "list",
              "--project",
              f.project_id,
            ])
          ).items,
          [],
        );
        assert.deepEqual(
          (
            await f.cli.read<Page<unknown>>([
              "scheduler",
              "queue",
              "list",
              f.project_id,
            ])
          ).items,
          [],
        );
      },
    );
  },
);

test("local mapped repository clones main and publishes only the node branch", async (t) => {
  const repo = await bareRepository(t, "test_repo");
  const transport = mappedTransport({ [REPOSITORY_ADDRESS]: repo.bare });
  const checkout = join(temporary(t), "checkout");
  mkdirSync(checkout);
  await transport.clone(
    REPOSITORY_ADDRESS,
    checkout,
    background,
    GIT_TIMEOUT_MS,
  );
  assert.equal(
    (await simpleGit(checkout).revparse(["HEAD"])).trim(),
    repo.head,
  );
  assert.equal(await remoteHead(repo.bare, `refs/heads/${TEST_BRANCH}`), null);
  await transport.fetchAndCheckout(
    checkout,
    TEST_BRANCH,
    "main",
    background,
    GIT_TIMEOUT_MS,
  );
  await transport.pushNodeBranch(
    checkout,
    TEST_BRANCH,
    background,
    GIT_TIMEOUT_MS,
  );
  assert.equal(
    await remoteHead(repo.bare, `refs/heads/${TEST_BRANCH}`),
    repo.head,
  );
  assert.equal(await remoteHead(repo.bare, MAIN_REF), repo.head);
  assert.throws(
    () =>
      transport.clone("test_unmapped", checkout, background, GIT_TIMEOUT_MS),
    assert.AssertionError,
  );
});
