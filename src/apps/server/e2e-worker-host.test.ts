import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  AssetKind,
  type Evidence,
  Intent,
  NodeState,
} from "../../mission/contract.ts";
import type { CredentialAnswer } from "../../custody/contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import {
  DEFAULT_SSH_PORT,
  startTestSshd,
} from "../../repository/sshd-test-support.ts";
import { ClaimState, type ExecutionRecord } from "../../scheduler/contract.ts";
import type { Span } from "../../tracking/contract.ts";
import type { RepositoryTransport } from "../../worker/contract.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import {
  FAKE_GITHUB_HOST_KEY,
  FAKE_SSH_CREDENTIAL,
  inProcessWorker,
} from "./test-support.ts";
import {
  WORKER_TEST_KEY,
  workerAcceptance,
} from "./worker-acceptance-test-support.ts";

const FIRST_REVISION = 1;
const SINGLE_ITEM = 1;
const SECOND_REVISION = 2;
const TWO_RESULTS = 2;
const PROVIDER_STORE_AND_SSH_PINS = 3;
const FIRST_INDEX = 0;
const POLL_INTERVAL_MS = 100;
const JOURNEY_TIMEOUT = 240000;
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
const PHASES = ["finish", "prepare", "start", "tasks"];
const TASK_LOOP_PHASE = "tasks";
const TASK_COMPLETED = "complete";
const TURN_OPERATION = "agent.turn";
const PASSED_EXIT = 0;
const UPLOAD_CALLS = 2;
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function fixture(t: TestContext) {
  const setup = await workerAcceptance(t, true, { fakeSlots: true });
  const mission = await setup.read<{ id: string }>([
    "mission",
    "get",
    setup.project_id,
  ]);
  const content = {
    name: "Greetings",
    requirement: "Write hello.txt",
    criterion: "hello.txt exists",
    verifications: ["test -f hello.txt"],
    bindings: [] as string[],
  };
  const examine = await setup.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "examine-1.md",
      content: { ...content, intent: Intent.Examine, verifications: ["true"] },
      tasks: [],
      reason: "plan",
      expected_mission_version: FIRST_REVISION,
    },
  );
  const implement = await setup.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "implement-a.md",
      content: {
        ...content,
        intent: Intent.Implement,
        bindings: [setup.bindings.repo!.id, setup.bindings.store!.id],
      },
      tasks: [{ filename: "task-a.md", content }],
      reason: "plan",
      expected_mission_version: SECOND_REVISION,
    },
  );
  const nodeId = implement.revisions[0]!.node_id;
  await setup.write(
    ["mission", "dependency", "add", examine.revisions[0]!.node_id, nodeId],
    { reason: "plan", expected_mission_version: SECOND_REVISION + 1 },
  );
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
  const sshKey = await setup.read<CredentialAnswer>([
    "repository",
    "credential",
    "get",
    FAKE_SSH_CREDENTIAL,
  ]);
  const publicKey = String(sshKey.revisions[0]?.metadata?.public_key);
  const sshd = await startTestSshd(t);
  await sshd.authorize(publicKey);
  const handed: SshAccess[] = [];
  const routed = (ssh: SshAccess): SshAccess => {
    handed.push(ssh);
    return { ...ssh, known_hosts: sshd.known_hosts, port: sshd.port };
  };
  const origin = sshd.url(bare);
  const connector = new RepositoryComponent();
  const transport: RepositoryTransport = {
    clone: (_address, directory, context, deadline, ssh) =>
      connector.clone(origin, directory, context, deadline, routed(ssh)),
    cloneSnapshot: (_address, revision, directory, context, deadline, ssh) =>
      connector.cloneSnapshot(
        origin,
        revision,
        directory,
        context,
        deadline,
        routed(ssh),
      ),
    fetchAndCheckout: (
      directory,
      branch,
      base,
      pushed,
      context,
      deadline,
      ssh,
    ) =>
      connector.fetchAndCheckout(
        directory,
        branch,
        base,
        pushed,
        context,
        deadline,
        routed(ssh),
      ),
    fetchBase: (directory, base, context, deadline, ssh) =>
      connector.fetchBase(directory, base, context, deadline, routed(ssh)),
    pushNodeBranch: (directory, branch, context, deadline, ssh) =>
      connector.pushNodeBranch(
        directory,
        branch,
        context,
        deadline,
        routed(ssh),
      ),
  };
  const auth = await setup.fixture.slotClient(setup.project_id, "general");
  assert.ok(nodeId);
  assert.ok(auth.client_secret);
  return {
    ...setup,
    node_id: nodeId,
    bare,
    git,
    auth,
    transport,
    handed,
    publicKey,
  };
}

async function assertSpanTree(
  setup: Awaited<ReturnType<typeof fixture>>,
  traceId: string,
) {
  const page = await setup.read<{ items: Span[] }>([
    "tracking",
    "span",
    "list",
    traceId,
  ]);
  const spans = page.items;
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const named = (operation: string) =>
    spans.filter((span) => span.operation === operation);
  const parentOf = (span: Span) => byId.get(span.parent_span_id ?? "");
  assert.ok(
    spans.every((span) => span.end_time !== null),
    JSON.stringify(spans),
  );
  const phases = named("worker.phase");
  assert.deepEqual(
    phases.map((span) => span.attributes["kanthord.phase"]).sort(),
    PHASES,
  );
  const [task] = named("worker.task");
  assert.equal(parentOf(task!)?.attributes["kanthord.phase"], TASK_LOOP_PHASE);
  assert.equal(task!.attributes["kanthord.task.result"], TASK_COMPLETED);
  const verifications = named("worker.verification");
  assert.ok(
    verifications.some(
      (span) =>
        span.attributes["process.exit.code"] === PASSED_EXIT &&
        span.parent_span_id === task!.span_id,
    ),
  );
  const turns = named(TURN_OPERATION);
  assert.ok(turns.some((turn) => turn.parent_span_id === task!.span_id));
  const tools = named("agent.tool");
  assert.ok(
    tools.every((span) => parentOf(span)?.operation === TURN_OPERATION),
  );
  assert.equal(
    tools.filter((span) => span.attributes["gen_ai.tool.name"] === UPLOAD)
      .length,
    UPLOAD_CALLS,
  );
}

async function finished(
  setup: Awaited<ReturnType<typeof fixture>>,
  signal: AbortSignal,
) {
  for (;;) {
    const page = await setup.read<{ items: ExecutionRecord[] }>([
      "scheduler",
      "execution",
      "list",
      setup.project_id,
      "--node",
      setup.node_id,
    ]);
    const record = page.items.find(
      (item) => item.claim_state === ClaimState.Finished,
    );
    if (record) {
      assert.equal(page.items.length, SINGLE_ITEM);
      assert.equal(record.credentials.length, PROVIDER_STORE_AND_SSH_PINS);
      return record;
    }
    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }
}

test(
  "E09.11–16 worker hosts offline execution, object upload and live failure boundaries",
  { timeout: JOURNEY_TIMEOUT },
  async (t) => {
    const executionSetup = await fixture(t);
    await t.test(
      "E09.11–14 execution publishes evidence and node branch",
      { timeout: JOURNEY_TIMEOUT },
      async (t) => {
        const provider = scriptedProvider([
          tool("bash", { command: "printf hello > hello.txt" }),
          tool(UPLOAD, { path: "hello.txt" }),
          tool(UPLOAD, { path: "../outside.txt" }),
          async () => {
            await executionSetup.read([
              "agent",
              "enablement",
              "disable",
              "swe@1",
              "--expected-revision",
              "1",
            ]);
            return fauxAssistantMessage("done");
          },
        ]);
        const host = await inProcessWorker(t, {
          endpoint: executionSetup.fixture.endpoint,
          ...executionSetup.auth,
          modelRuntimeFactory: scriptedModelRuntime(provider),
          repositoryTransport: executionSetup.transport,
        });
        const record = await finished(executionSetup, t.signal);
        assert.ok(executionSetup.handed.length);
        for (const ssh of executionSetup.handed) {
          assert.equal(ssh.public_key.trim(), executionSetup.publicKey.trim());
          assert.ok(ssh.known_hosts.includes(FAKE_GITHUB_HOST_KEY));
          assert.equal(ssh.port, DEFAULT_SSH_PORT);
        }
        await assertSpanTree(executionSetup, record.trace_id);
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
        const page = await executionSetup.read<{ items: Evidence[] }>([
          "mission",
          "evidence",
          "list",
          executionSetup.node_id,
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
        assert.equal(asset.media_type, MEDIA_TYPE);
        assert.ok(Number.isFinite(asset.published_at));
        assert.ok(asset.address.sha256);
        const grant = await executionSetup.read<{ get_url: string }>([
          "mission",
          "evidence",
          "asset",
          "content",
          "get",
          asset.id,
        ]);
        const response = await fetch(grant.get_url);
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
          "asset_id",
          "evidence_id",
          "uri",
        ]);
        assert.match(
          (success.details as { uri: string }).uri,
          /^s3:\/\/evidence\/kanthord\//,
        );
        assert.ok(refused.role === TOOL_RESULT && refused.isError);
        assert.ok(JSON.stringify(refused.content).includes(PATH_REFUSED));
        const trace = JSON.stringify(provider.calls);
        assert.ok(!trace.includes("put_url"));
        assert.ok(!trace.includes("X-Amz"));
        assert.ok(!trace.includes(executionSetup.s3!.endpoint));
        assert.match(
          await executionSetup.git.listRemote([
            executionSetup.bare,
            `refs/heads/kanthord/${executionSetup.node_id}`,
          ]),
          /^[a-f0-9]{40}\s/,
        );
        const node = await executionSetup.read<{ state: NodeState }>([
          "mission",
          "node",
          "get",
          executionSetup.node_id,
        ]);
        assert.equal(node.state, NodeState.Waiting);
        assert.equal(await host.worker.stop(), null);
        assert.equal(await host.running, null);
      },
    );
    const stopSetup = await fixture(t);
    await t.test(
      "E09.15 SIGTERM preserves a live claim and registration",
      { timeout: JOURNEY_TIMEOUT },
      async (t) => {
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
          endpoint: stopSetup.fixture.endpoint,
          ...stopSetup.auth,
          modelRuntimeFactory: scriptedModelRuntime(provider),
          repositoryTransport: stopSetup.transport,
        });
        await entered.promise;
        process.emit("SIGTERM");
        resume.resolve();
        const error = await host.running;
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, LIVE_STOP);
        await assertLive(stopSetup, host.logs);
      },
    );
    const handoverSetup = await fixture(t);
    const other = await handoverSetup.machine("general-b");
    await t.test(
      "E09.16 wrong secret refuses handover without release or deregistration",
      { timeout: JOURNEY_TIMEOUT },
      async (t) => {
        const provider = scriptedProvider([]);
        const host = await inProcessWorker(t, {
          endpoint: handoverSetup.fixture.endpoint,
          token: handoverSetup.auth.token,
          client_secret: other.client_secret,
          modelRuntimeFactory: scriptedModelRuntime(provider),
          repositoryTransport: handoverSetup.transport,
        });
        const error = await host.running;
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, DECRYPTION_FAILED);
        assert.deepEqual(provider.calls, []);
        await assertLive(handoverSetup, host.logs);
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
    setup.project_id,
    "--node",
    setup.node_id,
  ]);
  assert.equal(executions.items.length, SINGLE_ITEM);
  const claim = await setup.read<ExecutionRecord>(
    ["scheduler", "claim", "get", executions.items[0]!.execution_id],
    { ...setup.human, KANTHORD_TOKEN: setup.auth.token },
  );
  assert.equal(claim.claim_state, ClaimState.Running);
  const list = await setup.read<{
    items: { runtime_identity: string; registered: boolean }[];
  }>(["worker", "registration", "list", "--project", setup.project_id]);
  const identity = logs.find(
    (record) => record.msg === READY,
  )!.runtime_identity;
  assert.ok(
    list.items.some(
      (item) => item.runtime_identity === identity && item.registered,
    ),
  );
}
