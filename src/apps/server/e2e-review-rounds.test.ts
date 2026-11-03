import assert from "node:assert/strict";
import { unusedHostTools } from "../../worker/test-support.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { httpClient } from "../../gateway/client.ts";
import { plainHandoverPayloadSchema } from "../../custody/contract.ts";
import { executionCredentialStore } from "../../custody/index.ts";
import { background } from "../../kernel/context.ts";
import { writePrivate } from "../../kernel/files.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import {
  hostEnvironment,
  SUITE_CONCURRENCY,
  temporary,
} from "../../kernel/test-support.ts";
import {
  AssessmentResult,
  type Finding,
  FindingRoute,
  FindingStatus,
  Intent,
  missionOperations,
  NodeState,
} from "../../mission/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import {
  type ExecutionRecord,
  schedulerOperations,
  WorkPullKind,
} from "../../scheduler/contract.ts";
import {
  InstancePlacement,
  type RepositoryTransport,
  workerOperations,
} from "../../worker/contract.ts";
import {
  handedSshAccess,
  runNativeExecution,
  WorkspaceRoot,
} from "../../worker/unit/index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import { environment, kanthord } from "./cli-test-support.ts";
import {
  createFakeSshCredential,
  createInstancesByCli,
  gatewayFixture,
  instanceNames,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const ZERO_BYTE = 0;
const SINGLE_INSTANCE = 1;
const INITIAL_BINDING_VERSION = 1;
const JOURNEY_TIMEOUT_MS = 240000;
const NO_OUTPUT = "";
const SECRET = "test_e2e_review_rounds_secret";
const ADDRESS = "git@github.com:owner/repo.git";
const DEFAULTS = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
};
const CONTENT = {
  name: "Say hello",
  requirement: "Write hello.txt",
  criterion: "hello.txt exists",
  verifications: ["test -f hello.txt"],
  bindings: [] as string[],
};
const SUGGESTION_COUNT = 8;
const ROUND_PATCH_SUBJECT = "Review round patch";
const UNLISTED_LABEL = "S8";
const NO_OFFSET = 0;
const OPEN_AFTER_ROUND_TWO = 3;
const FIXED_AFTER_ROUND_THREE = 10;
const PATCH_EVIDENCES = 2;
const LARGE_FIX_BYTES = 6 * 1024 * 1024;
const ROUNDS = [1, 2, 3];
const SINGLE_ROUND = [1];
const CLOSED = "closed";
const NO_REWORK = 0;
const BLOCKER_COUNT = 2;
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const write = (path: string) => [
  tool("write", { path, content: path }),
  fauxAssistantMessage(`wrote ${path}`),
];
const judgement = (body: Record<string, unknown>) => [
  fauxAssistantMessage(
    `kanthord-judgement: ${JSON.stringify({ rationale: "judged", ...body })}`,
  ),
];
const item = (label: string) => ({
  label,
  action: "yes",
  task_id: null,
  ground: label.startsWith("B") ? "stated" : null,
  name: `Item ${label}`,
  description: `The defect ${label}`,
  fix: `Fix ${label}`,
  why: `Why ${label}`,
});
function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  return result.data;
}

async function roundsFixture(t: TestContext, reworkLimit?: number) {
  const f = await gatewayFixture(t, {
    fakeSlots: true,
    repositoryConnector: { gitLsRemote: async () => {} },
    ...(reworkLimit === undefined
      ? {}
      : { mission: { rework_limit: reworkLimit } }),
  });
  const directory = temporary(t);
  const human = {
    ...environment(directory),
    KANTHORD_ENDPOINT: f.endpoint,
    KANTHORD_TOKEN: f.token,
  };
  let sequence = 0;
  async function read<T>(args: string[], env = human): Promise<T> {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESSFUL_EXIT, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    return JSON.parse(result.stdout) as T;
  }
  function writeFile<T>(args: string[], body: unknown, env = human) {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return read<T>([...args, "--file", path], env);
  }
  await writeFile(["llm", "credential", "create"], {
    name: "anthro-1",
    platform: "anthropic",
    metadata: null,
    secret: { key: SECRET },
  });
  await writeFile(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test_rounds_github" },
  });
  await createFakeSshCredential(read);
  for (const agent of ["swe@1", "re@1"])
    await writeFile(["agent", "enablement", "put", agent], {
      agent_providers: [
        { name: "default", provider: "anthropic", credential: "anthro-1" },
      ],
      default_configuration: DEFAULTS,
      fallback_configurations: [],
    });
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "rounds",
  ]);
  const bindingSet = await writeFile<{
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: INITIAL_BINDING_VERSION,
    bindings: {
      repo: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: ADDRESS,
          ssh_credential: "github-ssh",
          strategy: { base_branch: "main" },
          credential: "github",
        },
      },
      general: {
        kind: "worker",
        config: {
          worker: "coder@1",
          worker_instances: await createInstancesByCli(
            read,
            instanceNames("general", SINGLE_INSTANCE),
          ),
          entries: [{ agent: "swe@1", ...DEFAULTS }],
        },
      },
      review: {
        kind: "worker",
        config: {
          worker: "reviewer@1",
          worker_instances: await createInstancesByCli(
            read,
            instanceNames("review", SINGLE_INSTANCE),
            InstancePlacement.Server,
            "reviewer@1",
          ),
          entries: [{ agent: "re@1", ...DEFAULTS }],
        },
      },
    },
  });
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const { version } = await read<{ version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  const created = await writeFile<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "hello.md",
      content: {
        ...CONTENT,
        intent: Intent.Implement,
        bindings: [bindingSet.bindings.repo!.id],
      },
      tasks: [],
      reason: "review rounds acceptance",
      expected_mission_version: version,
    },
  );
  const node = created.revisions[0]!.node_id;
  async function register(binding: string) {
    const auth = await f.slotClient(project.id, binding);
    const env = { ...human, KANTHORD_TOKEN: auth.token };
    const registration = await read<{ runtime_identity: string }>(
      ["worker", "register"],
      env,
    );
    return {
      ...auth,
      runtime_identity: registration.runtime_identity,
      env,
      binding,
    };
  }
  const coder = await register("general");
  const reviewer = await register("review");
  const seed = join(directory, "seed");
  mkdirSync(seed);
  const git = simpleGit(seed);
  await git.init(false, ["--initial-branch=main"]);
  await git.addConfig("user.name", "Rounds Test");
  await git.addConfig("user.email", "rounds@example.invalid");
  writeFileSync(join(seed, "README.md"), "rounds");
  await git.add("README.md");
  await git.commit("initial");
  const bare = join(directory, "repo.git");
  await git.clone(seed, bare, ["--bare"]);
  const connector = new RepositoryComponent();
  const transport: RepositoryTransport = {
    clone: async (_address, ...args) => {
      await connector.clone(bare, ...args);
      await simpleGit(args[0]).addConfig("user.name", "Rounds Test");
      await simpleGit(args[0]).addConfig(
        "user.email",
        "rounds@example.invalid",
      );
    },
    cloneSnapshot: (_address, ...args) =>
      connector.cloneSnapshot(bare, ...args),
    fetchAndCheckout: (...args) => connector.fetchAndCheckout(...args),
    fetchBase: (...args) => connector.fetchBase(...args),
    pushNodeBranch: (...args) => connector.pushNodeBranch(...args),
  };
  const workspaces = WorkspaceRoot.open(temporary(t));
  const missionClient = httpClient(missionOperations, f.endpoint, f.token);
  async function execute(
    holder: typeof coder,
    script: Parameters<typeof scriptedProvider>[0],
  ) {
    const pulled = await writeFile<{
      kind: string;
      execution: ExecutionRecord;
    }>(
      ["scheduler", "work", "pull"],
      {
        resource_identity: `worker:kanthord:${holder.binding}`,
        runtime_identity: holder.runtime_identity,
      },
      holder.env,
    );
    assert.equal(pulled.kind, WorkPullKind.Claimed);
    assert.equal(pulled.execution.node_id, node);
    const execution = pulled.execution;
    const workerClient = httpClient(workerOperations, f.endpoint, holder.token);
    const envelope = completed(
      await workerClient.handover({
        params: {},
        query: {},
        body: { execution_id: execution.execution_id },
      }),
    );
    const keys = deriveHandoverKeys(holder.client_secret);
    const aad = handoverAad(execution.execution_id, holder.runtime_identity);
    const payload = plainHandoverPayloadSchema.parse(
      openEnvelope(keys.handover, aad, envelope),
    );
    const credentials = executionCredentialStore(
      { items: payload.items },
      async (report) => {
        completed(
          await workerClient.credential({
            params: {},
            query: {},
            body: {
              execution_id: execution.execution_id,
              ...sealEnvelope(keys.report, aad, report),
            },
          }),
        );
      },
    );
    const setup = completed(
      await workerClient["execution.setup.get"]({
        params: { execution_id: execution.execution_id },
        query: {},
        body: null,
      }),
    );
    const provider = scriptedProvider(script);
    try {
      const result = await runNativeExecution({
        claim: execution,
        setup,
        clients: {
          mission: httpClient(missionOperations, f.endpoint, holder.token),
          scheduler: httpClient(schedulerOperations, f.endpoint, holder.token),
          worker: workerClient,
        },
        credentials: {
          items: [
            {
              credential_id: payload.items[0]!.credential_id,
              provider_id: payload.items[0]!.provider_id,
              store: credentials.store,
            },
          ],
          release: () => credentials.release(),
        },
        transport,
        sshAccess: handedSshAccess(payload.ssh_identities, setup.repositories),
        workspaces,
        hostHome: temporary(t),
        env: hostEnvironment(),
        modelRuntimeFactory: scriptedModelRuntime(provider),
        hostTools: () => unusedHostTools,
        context: background,
      });
      return { result, provider };
    } finally {
      credentials.discard();
      keys.handover.fill(ZERO_BYTE);
      keys.report.fill(ZERO_BYTE);
    }
  }
  const findings = async () =>
    completed(
      await missionClient["finding.list"]({
        params: { node_id: node },
        query: {},
        body: null,
      }),
    ).items as Finding[];
  const assessments = async () =>
    completed(
      await missionClient["assessment.list"]({
        params: { node_id: node },
        query: {},
        body: null,
      }),
    ).items;
  const evidence = async () =>
    completed(
      await missionClient["evidence.list"]({
        params: { node_id: node },
        query: {},
        body: null,
      }),
    ).items;
  const state = async () =>
    (await read<{ state: string }>(["mission", "node", "get", node])).state;
  return {
    execute,
    coder,
    reviewer,
    findings,
    assessments,
    evidence,
    state,
  };
}

function bundleOf(provider: { calls: unknown[] }) {
  const text = JSON.stringify(provider.calls[0]);
  const start = text.indexOf("Evidence: ");
  assert.ok(start > NO_OFFSET);
  return text.slice(start);
}

const REVOKED = { kind: "ended", reason: "revoked", code: null };
const RELEASED = { kind: "released", furtherWork: false };

suite("review rounds", { concurrency: SUITE_CONCURRENCY }, () => {
  test(
    "E09 three review rounds fix the action items and report the last unlisted item",
    { timeout: JOURNEY_TIMEOUT_MS },
    async (t) => {
      const f = await roundsFixture(t);
      assert.deepEqual(
        (await f.execute(f.coder, write("hello.txt"))).result,
        RELEASED,
      );
      const roundOne = await f.execute(
        f.reviewer,
        judgement({
          result: AssessmentResult.CriterionNotMet,
          findings: [
            ...Array.from({ length: BLOCKER_COUNT }, (_, index) =>
              item(`B${index + 1}`),
            ),
            ...Array.from({ length: SUGGESTION_COUNT }, (_, index) =>
              item(`S${index + 1}`),
            ),
          ],
        }),
      );
      assert.deepEqual(roundOne.result, REVOKED);
      assert.doesNotMatch(bundleOf(roundOne.provider), /patch_paths/);
      assert.equal(await f.state(), NodeState.Available);
      const first = await f.findings();
      assert.equal(first.length, BLOCKER_COUNT + SUGGESTION_COUNT);
      assert.ok(first.every((entry) => entry.route === FindingRoute.Fix));
      const fixOne = await f.execute(f.coder, [
        tool("bash", {
          command: `head -c ${LARGE_FIX_BYTES} /dev/zero | tr '\\0' x > fix-one.txt`,
        }),
        fauxAssistantMessage("wrote fix-one.txt"),
      ]);
      assert.deepEqual(fixOne.result, RELEASED);
      const revision = JSON.stringify(fixOne.provider.calls[0]);
      for (const entry of first) assert.ok(revision.includes(entry.id));
      const byLabel = (label: string) =>
        first.find((entry) => entry.label === label)!.id;
      const roundTwo = await f.execute(
        f.reviewer,
        judgement({
          result: AssessmentResult.Success,
          findings: [item("S1")],
          fixed_finding_ids: [
            "B1",
            "B2",
            "S1",
            "S2",
            "S3",
            "S4",
            "S5",
            "S6",
          ].map(byLabel),
        }),
      );
      assert.deepEqual(roundTwo.result, REVOKED);
      const bundleTwo = bundleOf(roundTwo.provider);
      assert.match(bundleTwo, /round-2-repo\.patch/);
      assert.match(bundleTwo, /\\"changed_files\\":\[\\"fix-one\.txt\\"\]/);
      assert.equal(await f.state(), NodeState.Available);
      const open = (await f.findings()).filter(
        (entry) => entry.status === FindingStatus.Open,
      );
      assert.equal(open.length, OPEN_AFTER_ROUND_TWO);
      const fixTwo = await f.execute(f.coder, write("fix-two.txt"));
      assert.deepEqual(fixTwo.result, RELEASED);
      const unlisted = open.find((entry) => entry.label === UNLISTED_LABEL)!;
      const roundThree = await f.execute(
        f.reviewer,
        judgement({
          result: AssessmentResult.Success,
          fixed_finding_ids: open
            .filter((entry) => entry.id !== unlisted.id)
            .map((entry) => entry.id),
        }),
      );
      assert.equal(roundThree.result.kind, CLOSED);
      const bundleThree = bundleOf(roundThree.provider);
      assert.match(bundleThree, /round-3-repo\.patch/);
      assert.match(bundleThree, /\\"changed_files\\":\[\\"fix-two\.txt\\"\]/);
      assert.equal(await f.state(), NodeState.Completed);
      const assessments = await f.assessments();
      assert.deepEqual(
        assessments.map((entry) => entry.round).toSorted(),
        ROUNDS,
      );
      const all = await f.findings();
      assert.equal(
        all.filter((entry) => entry.status === FindingStatus.Fixed).length,
        FIXED_AFTER_ROUND_THREE,
      );
      const reported = all.filter(
        (entry) => entry.route === FindingRoute.Report,
      );
      assert.deepEqual(
        reported.map((entry) => entry.id),
        [unlisted.id],
      );
      const patches = (await f.evidence()).filter(
        (entry) => entry.subject === ROUND_PATCH_SUBJECT,
      );
      assert.equal(patches.length, PATCH_EVIDENCES);
    },
  );

  test(
    "E09.2 a rework limit of 0 gives one final round with report-only findings",
    { timeout: JOURNEY_TIMEOUT_MS },
    async (t) => {
      const f = await roundsFixture(t, NO_REWORK);
      assert.deepEqual(
        (await f.execute(f.coder, write("hello.txt"))).result,
        RELEASED,
      );
      const round = await f.execute(
        f.reviewer,
        judgement({
          result: AssessmentResult.Success,
          findings: [item("S1"), item("S2")],
        }),
      );
      assert.equal(round.result.kind, CLOSED);
      assert.equal(await f.state(), NodeState.Completed);
      assert.deepEqual(
        (await f.assessments()).map((entry) => entry.round),
        SINGLE_ROUND,
      );
      assert.deepEqual(
        (await f.findings()).map((entry) => entry.route),
        [FindingRoute.Report, FindingRoute.Report],
      );
    },
  );
});
