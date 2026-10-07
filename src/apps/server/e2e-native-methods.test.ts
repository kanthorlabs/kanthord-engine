import assert from "node:assert/strict";
import { unusedHostTools } from "../../worker/test-support.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { parse, stringify } from "yaml";
import { configuration } from "../../config/index.ts";
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
import { temporary } from "../../kernel/test-support.ts";
import { missionOperations, type Evidence } from "../../mission/contract.ts";
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
} from "../../worker/index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import {
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  scriptedActions,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const ZERO_BYTE = 0;
const SINGLE_INSTANCE = 1;
const INITIAL_BINDING_VERSION = 1;
const SINGLE_TURN = 1;
const FIRST_REVISION = 1;
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
    'kanthord-judgement: {"criterionMet":true,"rationale":"hello.txt holds hello"}',
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

test(
  "E08 native methods execute, checkpoint, assess and request actions over HTTP",
  { timeout: 180000 },
  async (t) => {
    const actions = scriptedActions();
    const f = await gatewayFixture(t, {
      repositoryConnector: {
        gitLsRemote: async () => {},
        resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
      },
      standIns: { intakeActions: actions.seam },
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
      });
    const project = await read<{ id: string }>([
      "project",
      "create",
      "--name",
      "methods",
    ]);
    const worker = {
      worker: "general@1",
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
    const bindingSet = await write<{
      bindings: Record<string, { id: string }>;
    }>(["project", "binding", "apply", project.id], {
      version: INITIAL_BINDING_VERSION,
      bindings: {
        repo: { kind: "repository", config: repository("repo") },
        gated: {
          kind: "repository",
          config: {
            ...repository("gated"),
            strategy: {
              base_branch: "main",
              action: {
                name: "pull_request",
                follows: { type: "assessment_passed" },
              },
            },
          },
        },
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
          nodeId: string;
          tasks?: { id: string; filename: string }[];
        }[];
      }>(["mission", "node", "create", mission.id], {
        ...body,
        reason: "methods acceptance",
        expectedMissionVersion: version,
      });
      const task = result.revisions
        .flatMap((revision) => revision.tasks ?? [])
        .find((task) => task.filename === body.filename);
      return task?.id ?? result.revisions[0]!.nodeId;
    }
    const initiative = await create({
      filename: "initiative.md",
      kind: "initiative",
      content: { ...CONTENT, verifications: ["true"] },
    });
    const nodes: string[] = [];
    const tasks: string[] = [];
    for (const [index, name] of ["a", "b", "c"].entries()) {
      const binding =
        bindingSet.bindings[index === GATED_BINDING_INDEX ? "gated" : "repo"]!
          .id;
      const node = await create({
        filename: `${name}.md`,
        kind: "objective",
        parentId: initiative,
        expectedParentRevision: FIRST_REVISION,
        content: { ...CONTENT, bindings: [binding] },
      });
      nodes.push(node);
      tasks.push(
        await create({
          filename: `task-${name}.md`,
          kind: "task",
          parentId: node,
          expectedParentRevision: FIRST_REVISION,
          content: {
            ...CONTENT,
            criterion: "hello.txt holds hello",
            verifications: ["grep -q hello hello.txt"],
          },
        }),
      );
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
        expectedMissionVersion: version,
      });
    }
    writePrivate(
      join(directory, "server.yaml"),
      stringify(
        configuration({ master_key: f.config.master_key }).getProperties(),
      ),
    );
    function machine(binding: string) {
      const args = [
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
      const entry = new URL("../../main.ts", import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `process.stdout.isTTY=true;process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
        ],
        { env: human, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, SUCCESSFUL_EXIT, result.stderr);
      return parse(result.stdout) as { token: string; client_secret: string };
    }
    async function register(binding: string) {
      const auth = machine(binding);
      const env = { ...human, KANTHORD_TOKEN: auth.token };
      const registration = await read<{ runtime_identity: string }>(
        ["worker", "register"],
        env,
      );
      return {
        ...auth,
        runtimeIdentity: registration.runtime_identity,
        env,
        binding,
      };
    }
    const general = await register("general");
    const lab = await register("lab");
    const reviewer = await register("review");
    const barePaths = new Map<string, string>();
    for (const name of ["repo", "gated"]) {
      const seed = join(directory, name);
      mkdirSync(seed);
      const git = simpleGit(seed);
      await git.init(false, ["--initial-branch=main"]);
      await git.addConfig("user.name", "Methods Test");
      await git.addConfig("user.email", "methods@example.invalid");
      writeFileSync(
        join(seed, "AGENTS.md"),
        "WORKSPACE_AGENT_FILE_MUST_NOT_WIN",
      );
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
      pushNodeBranch: (...args) => connector.pushNodeBranch(...args),
    };
    const workspaces = WorkspaceRoot.open(temporary(t));
    async function execute(
      holder: typeof general,
      nodeId: string,
      script: Parameters<typeof scriptedProvider>[0],
    ) {
      const pulled = await write<{ kind: string; execution: ExecutionRecord }>(
        ["scheduler", "work", "pull"],
        {
          resourceIdentity: `worker:kanthord:${holder.binding}`,
          runtimeIdentity: holder.runtimeIdentity,
        },
        holder.env,
      );
      assert.equal(pulled.kind, WorkPullKind.Claimed);
      assert.equal(pulled.execution.nodeId, nodeId);
      const execution = pulled.execution;
      const workerClient = httpClient(
        workerOperations,
        f.endpoint,
        holder.token,
      );
      const envelope = completed(
        await workerClient.handover({
          params: {},
          query: {},
          body: { execution_id: execution.executionId },
        }),
      );
      const keys = deriveHandoverKeys(holder.client_secret);
      const aad = handoverAad(execution.executionId, holder.runtimeIdentity);
      const payload = handoverPayloadSchema.parse(
        openEnvelope(keys.handover, aad, envelope),
      );
      const credentials = executionCredentialStore(payload, async (report) => {
        completed(
          await workerClient.credential({
            params: {},
            query: {},
            body: {
              execution_id: execution.executionId,
              ...sealEnvelope(keys.report, aad, report),
            },
          }),
        );
      });
      const setup = completed(
        await workerClient["execution.setup.get"]({
          params: { execution_id: execution.executionId },
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
            scheduler: httpClient(
              schedulerOperations,
              f.endpoint,
              holder.token,
            ),
            worker: workerClient,
          },
          credentials,
          handoverItem: payload.items[0]!,
          transport,
          workspaces,
          hostHome: temporary(t),
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
    let headA = "";
    let headC = "";
    let gatedResource = "";
    await t.test("E08.1 objective task commit and head evidence", async () => {
      const answer = await execute(general, A, hello());
      assert.deepEqual(answer.result, { kind: "released", furtherWork: false });
      headA = (
        await simpleGit(
          barePaths.get("git@github.com:owner/repo.git")!,
        ).revparse([`refs/heads/kanthord/${A}`])
      ).trim();
      const items = (await evidence(A)).items;
      assert.equal(items.length, SINGLE_ITEM);
      assert.deepEqual(items[0]!.assets[0]!.address, {
        kind: "repository",
        bindingId: answer.setup.repositories[0]!.binding_id,
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
    await t.test("E08.2 gated objective publishes its task", async () => {
      const answer = await execute(general, C, hello());
      assert.deepEqual(answer.result, { kind: "released", furtherWork: false });
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
        assert.deepEqual(answer.result, {
          kind: "released",
          furtherWork: true,
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
        const claim = await read<{ claimState: string }>(
          ["scheduler", "claim", "get", answer.execution.executionId],
          lab.env,
        );
        const FINISHED = "finished";
        assert.equal(claim.claimState, FINISHED);
      },
    );
    await t.test(
      "E08.4 reviewer verifies objective and task and closes the claim",
      async () => {
        const answer = await execute(reviewer, A, review());
        const CLOSED = "closed";
        assert.equal(answer.result.kind, CLOSED);
        const verified = (await evidence(A)).items.find(
          (item) => item.verification,
        )!;
        assert.deepEqual(verified.verification!.testedInput, {
          kind: "repository",
          bindingId: answer.setup.repositories[0]!.binding_id,
          commit: headA,
        });
        assert.deepEqual(
          verified.verification!.results.map((result) => result.exitCode),
          [SUCCESSFUL_EXIT, SUCCESSFUL_EXIT],
        );
        assert.deepEqual(
          verified.verification!.results.map((result) => result.command),
          ["test -f hello.txt", "grep -q hello hello.txt"],
        );
        assert.equal(
          existsSync(workspaces.executionKey(answer.execution.executionId)),
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
        actions.performAnswers.push({
          kind: "pull_request",
          resource_identity: gatedResource,
          number: 42,
        });
        const answer = await execute(reviewer, C, review());
        assert.deepEqual(answer.result, {
          kind: "released",
          furtherWork: false,
        });
        assert.deepEqual(actions.performCalls[0]!.operands, {
          nodeBranch: `kanthord/${C}`,
          baseBranch: "main",
          commit: headC,
          reusedAddress: null,
        });
        assert.ok(
          (await evidence(C)).items.some(
            (item) => item.requirementKey === GATED_REQUIREMENT,
          ),
        );
        const REQUESTED = "External.Requested";
        assert.equal(await state(C), REQUESTED);
      },
    );
  },
);
