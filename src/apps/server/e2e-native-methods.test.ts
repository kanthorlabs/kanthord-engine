import assert from "node:assert/strict";
import { unusedHostTools } from "../../worker/test-support.ts";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { parse, stringify } from "yaml";
import { configuration, CONFIG_VERSION } from "../../config/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { handoverPayloadSchema } from "../../custody/contract.ts";
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
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary, hostEnvironment } from "../../kernel/test-support.ts";
import {
  ActorKind,
  AssessmentResult,
  missionOperations,
  NodeState,
  Intent,
  type Evidence,
} from "../../mission/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import {
  schedulerOperations,
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  workerOperations,
  type RepositoryTransport,
} from "../../worker/contract.ts";
import {
  WorkspaceRoot,
  runNativeExecution,
  noTranscript,
} from "../../worker/unit/index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import { environment, kanthord, kanthordTerminal } from "./cli-support.ts";
import {
  FAKE_SSH_IDENTITY,
  fakeGitHub,
  gatewayFixture,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const ZERO_BYTE = 0;
const SINGLE_INSTANCE = 1;
const INITIAL_BINDING_VERSION = 1;
const SINGLE_TURN = 1;
const SINGLE_ITEM = 1;
const GATED_BINDING_INDEX = 2;
const NO_OUTPUT = "";
const REPOSITORY = "repository";
const GATED_REQUIREMENT = "gated.pull_request";
const SECRET = "test_e2e_methods_secret";
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
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const hello = () => [
  tool("bash", { command: "printf hello > hello.txt" }),
  fauxAssistantMessage("done"),
  fauxAssistantMessage(
    'kanthord-judgement: {"criterion_met":true,"rationale":"hello.txt holds hello"}',
  ),
];
const review = () => [
  fauxAssistantMessage(
    'kanthord-judgement: {"result":"success","rationale":"hello.txt exists and holds hello; task met."}',
  ),
];
function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  return result.data;
}

async function methodsFixture(t: TestContext) {
  const gitHub = await fakeGitHub(t);
  const f = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
  });
  f.gitWriter.landedOn = async () => ({
    landed: false,
    first_parent: null,
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
    assert.equal(result.stdout.includes(SECRET), false);
    return JSON.parse(result.stdout) as T;
  }
  function write<T>(args: string[], body: unknown, env = human) {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return read<T>([...args, "--file", path], env);
  }
  await write(["llm", "credential", "create"], {
    name: "anthro-1",
    platform: "anthropic",
    metadata: null,
    secret: { key: SECRET },
  });
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test_methods_github" },
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
  for (const agent of ["swe@1", "re@1"])
    await write(["agent", "enablement", "put", agent], {
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
    "methods",
  ]);
  const worker = {
    worker: "coder@1",
    instance_count: SINGLE_INSTANCE,
    entries: [{ agent: "swe@1", ...DEFAULTS }],
  };
  const repository = (name: string) => ({
    available: true,
    platform: "github",
    address: `git@github.com:owner/${name}.git`,
    ssh_credential: "github-ssh",
    strategy: { base_branch: "main" },
    credential: "github",
  });
  const pullRequestBinding = (name: string) => ({
    kind: "repository",
    config: {
      ...repository(name),
      strategy: {
        base_branch: "main",
        action: {
          name: "pull_request",
          follows: { type: "assessment_passed" },
        },
      },
    },
  });
  const bindingSet = await write<{
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: INITIAL_BINDING_VERSION,
    bindings: {
      repo: { kind: "repository", config: repository("repo") },
      gated: pullRequestBinding("gated"),
      api: pullRequestBinding("api"),
      web: pullRequestBinding("web"),
      general: { kind: "worker", config: worker },
      lab: {
        kind: "worker",
        config: {
          ...worker,
          resource_budget: { turns: SINGLE_TURN, wall_time_ms: 600000 },
        },
      },
      review: {
        kind: "worker",
        config: {
          worker: "reviewer@1",
          instance_count: SINGLE_INSTANCE,
          entries: [{ agent: "re@1", ...DEFAULTS }],
        },
      },
    },
  });
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  async function create(body: Record<string, unknown>) {
    const { version } = await read<{ version: number }>([
      "mission",
      "get",
      project.id,
    ]);
    const result = await write<{
      revisions: {
        node_id: string;
        tasks: { id: string; filename: string }[];
      }[];
    }>(["mission", "node", "create", mission.id], {
      tasks: [],
      ...body,
      reason: "methods acceptance",
      expected_mission_version: version,
    });
    return result.revisions[0]!;
  }
  const nodes: string[] = [];
  const tasks: string[] = [];
  for (const [index, name] of ["a", "b", "c"].entries()) {
    const binding =
      bindingSet.bindings[index === GATED_BINDING_INDEX ? "gated" : "repo"]!.id;
    const node = await create({
      filename: `${name}.md`,
      content: { ...CONTENT, intent: Intent.Implement, bindings: [binding] },
      tasks: [
        {
          filename: `task-${name}.md`,
          content: {
            ...CONTENT,
            criterion: "hello.txt holds hello",
            verifications: ["grep -q hello hello.txt"],
          },
        },
      ],
    });
    nodes.push(node.node_id);
    tasks.push(node.tasks[0]!.id);
  }
  const [A, B, C] = nodes as [string, string, string];
  for (const [node, value] of [
    [A, 5],
    [C, 4],
    [B, 3],
  ] as const) {
    const { version } = await read<{ version: number }>([
      "mission",
      "get",
      project.id,
    ]);
    await write(["mission", "node", "priority", "set", node], {
      value,
      expected_mission_version: version,
    });
  }
  writePrivate(
    join(directory, "server.yaml"),
    stringify(
      configuration({
        version: CONFIG_VERSION,
        master_key: f.config.master_key,
      }).getProperties(),
    ),
  );
  async function machine(binding: string) {
    const args = [
      "auth",
      "jwt",
      "generate",
      "--project",
      project.id,
      "--binding",
      binding,
      "--name",
      `${binding}-a`,
      "--config",
      join(directory, "server.yaml"),
    ];
    const result = await kanthordTerminal(args, human);
    assert.equal(result.code, SUCCESSFUL_EXIT, result.stderr);
    return parse(result.stdout) as { token: string; client_secret: string };
  }
  async function register(binding: string) {
    const auth = await machine(binding);
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
  const general = await register("general");
  const lab = await register("lab");
  const reviewer = await register("review");
  const barePaths = new Map<string, string>();
  for (const name of ["repo", "gated", "api", "web"]) {
    const seed = join(directory, name);
    mkdirSync(seed);
    const git = simpleGit(seed);
    await git.init(false, ["--initial-branch=main"]);
    await git.addConfig("user.name", "Methods Test");
    await git.addConfig("user.email", "methods@example.invalid");
    writeFileSync(join(seed, "AGENTS.md"), "WORKSPACE_AGENT_FILE_MUST_NOT_WIN");
    await git.add("AGENTS.md");
    await git.commit("initial");
    const bare = join(directory, `${name}.git`);
    await git.clone(seed, bare, ["--bare"]);
    barePaths.set(`git@github.com:owner/${name}.git`, bare);
  }
  const connector = new RepositoryComponent();
  const transport: RepositoryTransport = {
    proveSshIdentity: async () => {},
    clone: async (address, ...args) => {
      await connector.clone(barePaths.get(address)!, ...args);
      await simpleGit(args[0]).addConfig("user.name", "Methods Test");
      await simpleGit(args[0]).addConfig(
        "user.email",
        "methods@example.invalid",
      );
    },
    cloneSnapshot: (address, ...args) =>
      connector.cloneSnapshot(barePaths.get(address)!, ...args),
    fetchAndCheckout: (...args) => connector.fetchAndCheckout(...args),
    fetchBase: (...args) => connector.fetchBase(...args),
    pushNodeBranch: (...args) => connector.pushNodeBranch(...args),
  };
  const workspaces = WorkspaceRoot.open(temporary(t));
  async function execute(
    holder: typeof general,
    nodeId: string,
    script: Parameters<typeof scriptedProvider>[0],
    beforeRun: (
      execution: ExecutionRecord,
      env: typeof human,
    ) => Promise<void> = async () => {},
  ) {
    const pulled = await write<{ kind: string; execution: ExecutionRecord }>(
      ["scheduler", "work", "pull"],
      {
        resource_identity: `worker:kanthord:${holder.binding}`,
        runtime_identity: holder.runtime_identity,
      },
      holder.env,
    );
    assert.equal(pulled.kind, WorkPullKind.Claimed);
    assert.equal(pulled.execution.node_id, nodeId);
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
    const payload = handoverPayloadSchema.parse(
      openEnvelope(keys.handover, aad, envelope),
    );
    const credentials = executionCredentialStore(payload, async (report) => {
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
    });
    const setup = completed(
      await workerClient["execution.setup.get"]({
        params: { execution_id: execution.execution_id },
        query: {},
        body: null,
      }),
    );
    const provider = scriptedProvider(script);
    try {
      await beforeRun(execution, holder.env);
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
        workspaces,
        hostHome: temporary(t),
        env: hostEnvironment(),
        modelRuntimeFactory: scriptedModelRuntime(provider),
        transcript: noTranscript,
        hostTools: () => unusedHostTools,
        context: background,
      });
      return { result, execution, provider, setup };
    } finally {
      credentials.discard();
      keys.handover.fill(ZERO_BYTE);
      keys.report.fill(ZERO_BYTE);
    }
  }
  const evidence = (node: string) =>
    read<{ items: Evidence[] }>([
      "mission",
      "evidence",
      "list",
      node,
      "--attempt",
      "1",
    ]);
  const state = async (node: string) =>
    (await read<{ state: string }>(["mission", "node", "get", node])).state;
  return {
    gitHub,
    read,
    write,
    create,
    execute,
    evidence,
    state,
    bindingSet,
    project,
    nodes,
    tasks,
    barePaths,
    workspaces,
    general,
    lab,
    reviewer,
  };
}

test(
  "E08 native methods execute, checkpoint, assess and request actions over HTTP",
  { timeout: 180000 },
  async (t) => {
    const {
      gitHub,
      execute,
      evidence,
      state,
      read,
      nodes,
      tasks,
      barePaths,
      workspaces,
      general,
      lab,
      reviewer,
    } = await methodsFixture(t);
    const [A, B, C] = nodes as [string, string, string];
    let headA = "";
    let headC = "";
    let gatedResource = "";
    await t.test("E08.1 implement task commit and head evidence", async () => {
      const answer = await execute(general, A, hello());
      assert.deepEqual(answer.result, {
        kind: "released",
        furtherWork: false,
      });
      headA = (
        await simpleGit(
          barePaths.get("git@github.com:owner/repo.git")!,
        ).revparse([`refs/heads/kanthord/${A}`])
      ).trim();
      const items = (await evidence(A)).items;
      assert.equal(items.length, SINGLE_ITEM);
      assert.deepEqual(items[0]!.assets[0]!.address, {
        kind: "repository",
        binding_id: answer.setup.repositories[0]!.binding_id,
        commit: headA,
      });
      assert.ok(
        (
          await simpleGit(barePaths.get("git@github.com:owner/repo.git")!).raw([
            "log",
            "-1",
            "--format=%s",
            headA,
          ])
        ).includes(tasks[0]!),
      );
      const WAITING = "Waiting";
      assert.equal(await state(A), WAITING);
    });
    await t.test("E08.2 gated implement node publishes its task", async () => {
      const answer = await execute(general, C, hello());
      assert.deepEqual(answer.result, {
        kind: "released",
        furtherWork: false,
      });
      headC = (
        await simpleGit(
          barePaths.get("git@github.com:owner/gated.git")!,
        ).revparse([`refs/heads/kanthord/${C}`])
      ).trim();
      const asset = (await evidence(C)).items[0]!.assets[0]!;
      assert.ok(asset.kind === REPOSITORY);
      assert.equal(asset.address.commit, headC);
      gatedResource = "repository:github:owner/gated";
    });
    await t.test(
      "E08.3 turn budget publishes a checkpoint without evidence",
      async () => {
        const answer = await execute(lab, B, [
          tool("write", { path: "notes.txt", content: "partial" }),
          tool("write", { path: "never.txt", content: "never" }),
        ]);
        const budgetEnd = { reason: "budget_end", code: "turns" };
        assert.deepEqual(answer.result, {
          kind: "released",
          furtherWork: true,
          stop: budgetEnd,
        });
        assert.equal(answer.provider.calls.length, SINGLE_ITEM);
        assert.deepEqual((await evidence(B)).items, []);
        const git = simpleGit(barePaths.get("git@github.com:owner/repo.git")!);
        assert.match(
          await git.raw([
            "log",
            "-1",
            "--format=%s",
            `refs/heads/kanthord/${B}`,
          ]),
          /checkpoint of task/,
        );
        assert.ok(
          (
            await git.raw([
              "ls-tree",
              "--name-only",
              `refs/heads/kanthord/${B}`,
            ])
          ).includes("notes.txt"),
        );
        const AVAILABLE = "Available";
        assert.equal(await state(B), AVAILABLE);
        const claim = await read<{ claim_state: string; stop: unknown }>(
          ["scheduler", "claim", "get", answer.execution.execution_id],
          lab.env,
        );
        const FINISHED = "finished";
        assert.equal(claim.claim_state, FINISHED);
        assert.deepEqual(claim.stop, budgetEnd);
      },
    );
    await t.test(
      "E08.4 reviewer verifies implement node and task and closes the claim",
      async () => {
        const answer = await execute(reviewer, A, review());
        const CLOSED = "closed";
        assert.equal(answer.result.kind, CLOSED);
        const verified = (await evidence(A)).items.find(
          (item) => item.verification,
        )!;
        assert.deepEqual(verified.verification!.tested_input, {
          kind: "repository",
          binding_id: answer.setup.repositories[0]!.binding_id,
          commit: headA,
        });
        assert.deepEqual(
          verified.verification!.results.map((result) => result.exit_code),
          [SUCCESSFUL_EXIT, SUCCESSFUL_EXIT],
        );
        assert.deepEqual(
          verified.verification!.results.map((result) => result.command),
          ["test -f hello.txt", "grep -q hello hello.txt"],
        );
        assert.equal(
          existsSync(workspaces.executionKey(answer.execution.execution_id)),
          false,
        );
        assert.equal(
          JSON.stringify(answer.provider.calls).includes(
            "WORKSPACE_AGENT_FILE_MUST_NOT_WIN",
          ),
          false,
        );
        const COMPLETED = "Completed";
        assert.equal(await state(A), COMPLETED);
      },
    );
    await t.test(
      "E08.5 passing reviewer requests the gated action before release",
      async () => {
        const answer = await execute(reviewer, C, review());
        assert.deepEqual(answer.result, {
          kind: "released",
          furtherWork: false,
        });
        assert.deepEqual(
          gitHub.calls.map((call) => ({
            method: call.method,
            path: call.path,
            body: call.body,
            token: call.token,
          })),
          [
            {
              method: "POST",
              path: "/repos/owner/gated/pulls",
              body: {
                head: `kanthord/${C}`,
                base: "main",
                title: `kanthord ${C}`,
              },
              token: "test_methods_github",
            },
          ],
        );
        const requested = (await evidence(C)).items.find(
          (item) => item.requirement_key === GATED_REQUIREMENT,
        );
        assert.deepEqual(requested?.assets[0]?.address, {
          kind: "pull_request",
          resource_identity: gatedResource,
          number: gitHub.pulls[0]!.number,
        });
        const REQUESTED = "External.Requested";
        assert.equal(await state(C), REQUESTED);
      },
    );
  },
);

const CHECKOUT_FLOW_PRIORITY = 10;
const TWO_ASSETS = 2;
const FAILED_EXIT = 1;
const MERGE_COMMITS = { api: "a".repeat(40), web: "b".repeat(40) };
const BOTH_HELLO = () => [
  tool("bash", {
    command: "printf hello > api/hello.txt && printf hello > web/hello.txt",
  }),
  fauxAssistantMessage("done"),
  fauxAssistantMessage(
    'kanthord-judgement: {"criterion_met":true,"rationale":"both checkouts hold hello.txt"}',
  ),
];

test(
  "EF09b.1-EF09b.5 an implement node with two repository bindings runs, reviews and lands over HTTP",
  { timeout: 180000 },
  async (t) => {
    const h = await methodsFixture(t);
    const api = h.bindingSet.bindings.api!.id;
    const web = h.bindingSet.bindings.web!.id;
    const version = async () =>
      (await h.read<{ version: number }>(["mission", "get", h.project.id]))
        .version;
    const checkoutFlow = (
      await h.create({
        filename: "checkout-flow.md",
        content: {
          ...CONTENT,
          name: "Checkout flow",
          criterion: "each checkout holds hello.txt",
          verifications: ["test -f api/hello.txt && test -f web/hello.txt"],
          intent: Intent.Implement,
          bindings: [api, web],
        },
        tasks: [
          {
            filename: "task-checkout-flow.md",
            content: {
              ...CONTENT,
              criterion: "each checkout holds hello",
              verifications: [
                "grep -q hello api/hello.txt && grep -q hello web/hello.txt",
              ],
            },
          },
        ],
      })
    ).node_id;
    await h.write(["mission", "node", "priority", "set", checkoutFlow], {
      value: CHECKOUT_FLOW_PRIORITY,
      expected_mission_version: await version(),
    });
    const bare = (name: string) =>
      simpleGit(h.barePaths.get(`git@github.com:owner/${name}.git`)!);
    await t.test(
      "EF09b.1 the node get holds api and web in binding order",
      async () => {
        const node = await h.read<{ content: { bindings: string[] } }>([
          "mission",
          "node",
          "get",
          checkoutFlow,
        ]);
        assert.deepEqual(node.content.bindings, [api, web]);
      },
    );
    let refused: Awaited<ReturnType<typeof kanthord>> | null = null;
    const heads: string[] = [];
    await t.test(
      "EF09b.2 one steps execution pushes both node branches and submits one evidence",
      async () => {
        const answer = await h.execute(
          h.general,
          checkoutFlow,
          BOTH_HELLO(),
          async (execution, env) => {
            const path = join(temporary(t), "evidence.json");
            writePrivate(
              path,
              JSON.stringify({
                execution_id: execution.execution_id,
                attempt: execution.attempt,
                node_revision: execution.pinned_revision,
                subject: "api alone",
                assets: [
                  {
                    kind: "repository",
                    address: {
                      kind: "repository",
                      binding_id: api,
                      commit: (await bare("api").revparse(["main"])).trim(),
                    },
                  },
                ],
              }),
            );
            refused = await kanthord(
              ["mission", "evidence", "submit", checkoutFlow, "--file", path],
              env,
            );
          },
        );
        assert.deepEqual(answer.result, {
          kind: "released",
          furtherWork: false,
        });
        for (const name of ["api", "web"])
          heads.push(
            (
              await bare(name).revparse([`refs/heads/kanthord/${checkoutFlow}`])
            ).trim(),
          );
        const items = (await h.evidence(checkoutFlow)).items;
        assert.equal(items.length, SINGLE_ITEM);
        assert.equal(items[0]!.assets.length, TWO_ASSETS);
        for (const [index, binding_id] of [api, web].entries())
          assert.deepEqual(
            items[0]!.assets
              .map((asset) => asset.address)
              .filter(
                (address) =>
                  address.kind === REPOSITORY &&
                  address.binding_id === binding_id,
              ),
            [{ kind: REPOSITORY, binding_id, commit: heads[index] }],
          );
      },
    );
    await t.test(
      "EF09b.3 one repository asset of api alone answers mission.evidence.binding_mismatch",
      () => {
        assert.ok(refused);
        assert.equal(refused.code, FAILED_EXIT);
        assert.ok(
          refused.stderr.startsWith("mission.evidence.binding_mismatch:"),
          refused.stderr,
        );
      },
    );
    await t.test(
      "EF09b.4 one reviewer execution writes one success assessment with a tested input list",
      async () => {
        const answer = await h.execute(h.reviewer, checkoutFlow, review());
        assert.deepEqual(answer.result, {
          kind: "released",
          furtherWork: false,
        });
        const assessments = await h.read<{
          items: { result: string; tested_input: unknown }[];
        }>(["mission", "assessment", "list", checkoutFlow]);
        assert.equal(assessments.items.length, SINGLE_ITEM);
        assert.equal(assessments.items[0]!.result, AssessmentResult.Success);
        assert.deepEqual(
          assessments.items[0]!.tested_input,
          [api, web].map((binding_id, index) => ({
            kind: "repository",
            binding_id,
            commit: heads[index],
          })),
        );
        assert.deepEqual(
          h.gitHub.pulls.map(({ repo, head }) => ({ repo, head })),
          ["api", "web"].map((repo) => ({
            repo,
            head: `kanthord/${checkoutFlow}`,
          })),
        );
      },
    );
    await t.test(
      "EF09b.5 both merged pull requests complete the node with one landed commit for each binding",
      async () => {
        for (const pull of h.gitHub.pulls)
          h.gitHub.merge(
            pull.number,
            MERGE_COMMITS[pull.repo as keyof typeof MERGE_COMMITS],
          );
        await h.write(["mission", "node", "check", checkoutFlow], {
          expected_mission_version: await version(),
        });
        assert.equal(await h.state(checkoutFlow), NodeState.Completed);
        const outcomes = await h.read<{ items: { evidence_ids: string[] }[] }>([
          "mission",
          "outcome",
          "list",
          checkoutFlow,
        ]);
        assert.equal(outcomes.items.length, SINGLE_ITEM);
        const landed = (await h.evidence(checkoutFlow)).items.filter(
          (item) =>
            outcomes.items[0]!.evidence_ids.includes(item.id) &&
            item.provenance.kind === ActorKind.Service,
        );
        assert.deepEqual(
          landed
            .flatMap((item) => item.assets)
            .map((asset) => asset.address)
            .sort((left, right) =>
              JSON.stringify(left).localeCompare(JSON.stringify(right)),
            ),
          [
            { binding_id: api, commit: MERGE_COMMITS.api },
            { binding_id: web, commit: MERGE_COMMITS.web },
          ]
            .map((address) => ({ kind: "repository", ...address }))
            .sort((left, right) =>
              JSON.stringify(left).localeCompare(JSON.stringify(right)),
            ),
        );
      },
    );
  },
);
