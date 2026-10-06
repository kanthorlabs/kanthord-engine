import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { Diagnostic } from "../../kernel/errors.ts";
import { AssetKind, NodeState, type Evidence } from "../../mission/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { ClaimState, type ExecutionRecord } from "../../scheduler/contract.ts";
import type { RepositoryTransport } from "../../worker/index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/test-support.ts";
import { inProcessWorker } from "./test-support.ts";
import { workerAcceptance, WORKER_TEST_KEY } from "./worker-acceptance.ts";

const FIRST_REVISION = 1;
const SINGLE_ITEM = 1;
const SECOND_REVISION = 2;
const TWO_RESULTS = 2;
const THIRD_REVISION = 3;
const FIRST_INDEX = 0;
const POLL_LIMIT = 30;
const FILE_NAME = "hello.txt";
const HELLO = "hello";
const SIZE = 5;
const MEDIA_TYPE = "application/octet-stream";
const TOOL_RESULT = "toolResult";
const UPLOAD = "evidence-upload";
const READY = "Worker application ready";
const CLAIMED = "credential handover received";
const LIVE_STOP = "worker.stop.execution_live";
const DECRYPTION_FAILED = "worker.handover.decryption_failed";
const PATH_REFUSED = "worker.evidence_upload.path_refused";
const JUDGEMENT =
  'kanthord-judgement: {"criterionMet":true,"rationale":"hello.txt holds hello"}';
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function fixture(t: TestContext) {
  const setup = await workerAcceptance(t, true);
  const mission = await setup.read<{ id: string }>([
    "mission",
    "get",
    setup.projectId,
  ]);
  const content = {
    name: "Greetings",
    requirement: "Write hello.txt",
    criterion: "hello.txt exists",
    verifications: ["test -f hello.txt"],
    bindings: [] as string[],
  };
  const initiative = await setup.write<{ revisions: { nodeId: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "initiative-1.md",
      kind: "initiative",
      content: { ...content, verifications: ["true"] },
      reason: "plan",
      expectedMissionVersion: FIRST_REVISION,
    },
  );
  const objective = await setup.write<{ revisions: { nodeId: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "objective-a.md",
      kind: "objective",
      parentId: initiative.revisions[0]!.nodeId,
      expectedParentRevision: FIRST_REVISION,
      content: {
        ...content,
        bindings: [setup.bindings.repo!.id, setup.bindings.store!.id],
      },
      reason: "plan",
      expectedMissionVersion: SECOND_REVISION,
    },
  );
  const nodeId = objective.revisions[0]!.nodeId;
  await setup.write(["mission", "node", "create", mission.id], {
    filename: "task-a.md",
    kind: "task",
    parentId: nodeId,
    expectedParentRevision: FIRST_REVISION,
    content,
    reason: "plan",
    expectedMissionVersion: THIRD_REVISION,
  });
  const seed = join(setup.directory, "seed");
  const bare = join(setup.directory, "bare.git");
  mkdirSync(seed, { mode: 0o700 });
  const git = simpleGit(seed);
  await git.init(false, ["--initial-branch=main"]);
  await git.addConfig("user.name", "Worker Test");
  await git.addConfig("user.email", "worker@example.invalid");
  writeFileSync(join(seed, "README.md"), "Worker acceptance\n");
  await git.add("README.md");
  await git.commit("initial");
  await git.clone(seed, bare, ["--bare"]);
  const connector = new RepositoryComponent();
  const transport: RepositoryTransport = {
    proveSshIdentity: async () => {},
    clone: (_address, ...args) => connector.clone(bare, ...args),
    cloneSnapshot: (_address, ...args) =>
      connector.cloneSnapshot(bare, ...args),
    fetchAndCheckout: (...args) => connector.fetchAndCheckout(...args),
    pushNodeBranch: (...args) => connector.pushNodeBranch(...args),
  };
  const auth = setup.machine("general-a");
  assert.ok(nodeId);
  assert.ok(auth.clientSecret);
  return { ...setup, nodeId, bare, git, auth, transport };
}

async function finished(setup: Awaited<ReturnType<typeof fixture>>) {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt++) {
    const page = await setup.read<{ items: ExecutionRecord[] }>([
      "scheduler",
      "execution",
      "list",
      setup.projectId,
      "--node",
      setup.nodeId,
    ]);
    const record = page.items.find(
      (item) => item.claimState === ClaimState.Finished,
    );
    if (record) {
      assert.equal(page.items.length, SINGLE_ITEM);
      assert.equal(record.credentials.length, SINGLE_ITEM);
      return record;
    }
    await delay(100);
  }
  throw new Error("Worker execution did not finish");
}

test(
  "E09.11–16 worker hosts offline execution, object upload and live failure boundaries",
  { timeout: 240000 },
  async (t) => {
    await t.test(
      "E09.11–14 execution publishes evidence and node branch",
      { timeout: 90000 },
      async (t) => {
        const setup = await fixture(t);
        const provider = scriptedProvider([
          tool("bash", { command: "printf hello > hello.txt" }),
          tool(UPLOAD, { path: "hello.txt" }),
          tool(UPLOAD, { path: "../outside.txt" }),
          fauxAssistantMessage("done"),
          async () => {
            await setup.read([
              "agent",
              "enablement",
              "disable",
              "swe@1",
              "--expected-revision",
              "1",
            ]);
            return fauxAssistantMessage(JUDGEMENT);
          },
        ]);
        const host = await inProcessWorker(t, {
          endpoint: setup.fixture.endpoint,
          ...setup.auth,
          modelRuntimeFactory: scriptedModelRuntime(provider),
          repositoryTransport: setup.transport,
        });
        await finished(setup);
        assert.ok(provider.calls.length);
        assert.ok(
          provider.calls.every((call) => call.apiKey === WORKER_TEST_KEY),
        );
        const ready = host.logs.findIndex((record) => record.msg === READY);
        const claimed = host.logs.findIndex((record) => record.msg === CLAIMED);
        assert.ok(
          ready >= FIRST_INDEX && claimed > ready,
          JSON.stringify(host.logs),
        );
        const page = await setup.read<{ items: Evidence[] }>([
          "mission",
          "evidence",
          "list",
          setup.nodeId,
          "--attempt",
          "1",
        ]);
        const uploaded = page.items.filter(
          (item) => item.subject === FILE_NAME,
        );
        assert.equal(uploaded.length, SINGLE_ITEM);
        const assets = uploaded[0]!.assets;
        assert.equal(assets.length, SINGLE_ITEM);
        const asset = assets[0]!;
        assert.equal(asset.kind, AssetKind.Object);
        assert.ok(asset.kind === AssetKind.Object);
        assert.equal(asset.size, SIZE);
        assert.equal(asset.mediaType, MEDIA_TYPE);
        assert.ok(Number.isFinite(asset.publishedAt));
        assert.ok(asset.address.sha256);
        const grant = await setup.read<{ getUrl: string }>([
          "mission",
          "evidence",
          "asset",
          "content",
          "get",
          asset.id,
        ]);
        const response = await fetch(grant.getUrl);
        assert.ok(response.ok);
        assert.equal(await response.text(), HELLO);
        const messages = provider.calls.at(-1)!.messages;
        const results = messages.filter(
          (message) =>
            message.role === TOOL_RESULT && message.toolName === UPLOAD,
        );
        assert.equal(results.length, TWO_RESULTS);
        const success = results[0]!;
        const refused = results[1]!;
        assert.ok(success.role === TOOL_RESULT && !success.isError);
        assert.deepEqual(Object.keys(success.details as object).sort(), [
          "assetId",
          "evidenceId",
          "uri",
        ]);
        assert.match(
          (success.details as { uri: string }).uri,
          /^s3:\/\/evidence\/kanthord\//,
        );
        assert.ok(refused.role === TOOL_RESULT && refused.isError);
        assert.ok(JSON.stringify(refused.content).includes(PATH_REFUSED));
        const trace = JSON.stringify(provider.calls);
        assert.ok(!trace.includes("putUrl"));
        assert.ok(!trace.includes("X-Amz"));
        assert.ok(!trace.includes(setup.sink!.endpoint));
        assert.match(
          await setup.git.listRemote([
            setup.bare,
            `refs/heads/kanthord/${setup.nodeId}`,
          ]),
          /^[a-f0-9]{40}\s/,
        );
        const node = await setup.read<{ state: NodeState }>([
          "mission",
          "node",
          "get",
          setup.nodeId,
        ]);
        assert.equal(node.state, NodeState.Waiting);
        assert.equal(await host.worker.stop(), null);
        assert.equal(await host.running, null);
      },
    );
    await t.test(
      "E09.15 SIGTERM preserves a live claim and registration",
      { timeout: 90000 },
      async (t) => {
        const setup = await fixture(t);
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const provider = scriptedProvider([
          async () => {
            entered.resolve();
            await resume.promise;
            return fauxAssistantMessage("stopped");
          },
        ]);
        const host = await inProcessWorker(t, {
          endpoint: setup.fixture.endpoint,
          ...setup.auth,
          modelRuntimeFactory: scriptedModelRuntime(provider),
          repositoryTransport: setup.transport,
        });
        await entered.promise;
        process.emit("SIGTERM");
        resume.resolve();
        const error = await host.running;
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, LIVE_STOP);
        await assertLive(setup, host.logs);
      },
    );
    await t.test(
      "E09.16 wrong secret refuses handover without release or deregistration",
      { timeout: 90000 },
      async (t) => {
        const setup = await fixture(t);
        const other = setup.machine("general-b");
        const provider = scriptedProvider([]);
        const host = await inProcessWorker(t, {
          endpoint: setup.fixture.endpoint,
          token: setup.auth.token,
          clientSecret: other.clientSecret,
          modelRuntimeFactory: scriptedModelRuntime(provider),
          repositoryTransport: setup.transport,
        });
        const error = await host.running;
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, DECRYPTION_FAILED);
        assert.deepEqual(provider.calls, []);
        await assertLive(setup, host.logs);
      },
    );
  },
);

async function assertLive(
  setup: Awaited<ReturnType<typeof fixture>>,
  logs: Record<string, unknown>[],
) {
  const executions = await setup.read<{ items: ExecutionRecord[] }>([
    "scheduler",
    "execution",
    "list",
    setup.projectId,
    "--node",
    setup.nodeId,
  ]);
  assert.equal(executions.items.length, SINGLE_ITEM);
  const claim = await setup.read<ExecutionRecord>(
    ["scheduler", "claim", "get", executions.items[0]!.executionId],
    { ...setup.human, KANTHORD_TOKEN: setup.auth.token },
  );
  assert.equal(claim.claimState, ClaimState.Running);
  const list = await setup.read<{
    items: { runtimeIdentity: string; registered: boolean }[];
  }>(["worker", "instance", "list", "--project", setup.projectId]);
  const identity = logs.find((record) => record.msg === READY)!.runtimeIdentity;
  assert.ok(
    list.items.some(
      (item) => item.runtimeIdentity === identity && item.registered,
    ),
  );
}
