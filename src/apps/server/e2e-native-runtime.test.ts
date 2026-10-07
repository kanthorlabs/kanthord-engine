import assert from "node:assert/strict";
import { unusedHostTools } from "../../worker/test-support.ts";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
} from "../../kernel/handover.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import { missionOperations } from "../../mission/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  WorkerMethod,
  workerOperations,
  type RepositoryTransport,
} from "../../worker/contract.ts";
import { agentOperations } from "../../agent/contract.ts";
import { SWE_AGENT_PROMPT } from "../../agent/prompt-assets.ts";
import { framing, PromptConsumer } from "../../agent/prompt-render.ts";
import { WORKING_LAYER_ALL_ON } from "../../worker/test-support.ts";
import {
  WorkspaceRoot,
  WorkspaceKind,
  openNativeAgent,
  renderWorkPrompt,
  runVerifications,
  verificationPassed,
  discardChanges,
  headCommit,
} from "../../worker/index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import {
  FAKE_SSH_CREDENTIAL_BODY,
  FAKE_SSH_IDENTITY,
  gatewayFixture,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const ZERO_BYTE = 0;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const SINGLE_TURN = 1;
const FAILURE_EXIT = 1;
const BRACKET_TRIM_OFFSET = 1;
const SINGLE_CALL = 1;
const MISSION_VERSION_BASE = 2;
const THREE_CALLS = 3;
const PRIVATE_MODE = 0o700;
const NO_OUTPUT = "";
const SECRET = "test_e2e-runtime-secret";
const GLOBAL = "Every answer is short.";
const PROJECT = "The work product is TypeScript.";
const REPOSITORY_OWNER = "repository binding repo";
const WORKSPACE_FILE = "Workspace agent file text.";
const ADDRESS = "git@github.com:owner/repo.git";
const SWE = "swe@1";
const PROOF_FAILED = "gateway.invocation.execution_proof_failed";
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
function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  return result.data;
}

test(
  "E07 native runtime proves setup, inference, verification, push, budget and retention in order",
  { timeout: 180000 },
  async (t) => {
    const f = await gatewayFixture(t, {
      repositoryConnector: {
        gitLsRemote: async () => {},
        resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
      },
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
      "runtime",
    ]);
    const worker = {
      worker: "general@1",
      instance_count: SINGLE_INSTANCE,
      entries: [{ agent: "swe@1", ...DEFAULTS }],
    };
    const bindingSet = await write<{
      bindings: Record<string, { id: string }>;
    }>(["project", "binding", "apply", project.id], {
      version: FIRST_REVISION,
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
            project_prompt: PROJECT,
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
      },
    });
    const mission = await read<{ id: string }>(["mission", "get", project.id]);
    const initiative = await write<{ revisions: { nodeId: string }[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename: "initiative.md",
        kind: "initiative",
        content: { ...CONTENT, bindings: [] },
        reason: "runtime acceptance",
        expectedMissionVersion: FIRST_REVISION,
      },
    );
    for (const [index, name] of ["a", "b"].entries())
      await write(["mission", "node", "create", mission.id], {
        filename: `${name}.md`,
        kind: "objective",
        content: { ...CONTENT, bindings: [bindingSet.bindings.repo!.id] },
        reason: "runtime acceptance",
        expectedMissionVersion: index + MISSION_VERSION_BASE,
        parentId: initiative.revisions[0]!.nodeId,
        expectedParentRevision: FIRST_REVISION,
      });
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
    async function claim(binding: string) {
      const auth = machine(binding);
      const env = { ...human, KANTHORD_TOKEN: auth.token };
      const registration = await read<{ runtimeIdentity: string }>(
        ["worker", "register"],
        env,
      );
      const result = await write<{ kind: string; execution: ExecutionRecord }>(
        ["scheduler", "work", "pull"],
        {
          resourceIdentity: `worker:kanthord:${binding}`,
          runtimeIdentity: registration.runtimeIdentity,
        },
        env,
      );
      assert.equal(result.kind, WorkPullKind.Claimed);
      return {
        ...auth,
        ...registration,
        execution: result.execution,
        client: httpClient(workerOperations, f.endpoint, auth.token),
      };
    }
    const x = await claim("general");
    const y = await claim("lab");
    const seed = join(directory, "seed");
    const bare = join(directory, "bare.git");
    mkdirSync(seed, { mode: PRIVATE_MODE });
    const git = simpleGit(seed);
    await git.init(false, ["--initial-branch=main"]);
    await git.addConfig("user.name", "Runtime Test");
    await git.addConfig("user.email", "runtime@example.invalid");
    writeFileSync(join(seed, "AGENTS.md"), WORKSPACE_FILE);
    await git.add("AGENTS.md");
    await git.commit("initial");
    const main = (await git.revparse(["HEAD"])).trim();
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
    async function handover(holder: typeof x) {
      const envelope = completed(
        await holder.client.handover({
          params: {},
          query: {},
          body: { executionId: holder.execution.executionId },
        }),
      );
      const keys = deriveHandoverKeys(holder.client_secret);
      const payload = handoverPayloadSchema.parse(
        openEnvelope(
          keys.handover,
          handoverAad(holder.execution.executionId, holder.runtimeIdentity),
          envelope,
        ),
      );
      keys.handover.fill(ZERO_BYTE);
      keys.report.fill(ZERO_BYTE);
      const credentials = executionCredentialStore(payload, async () => {
        throw new Error("Unexpected refresh");
      });
      t.after(() => credentials.discard());
      const setup = completed(
        await holder.client["execution.setup.get"]({
          params: { executionId: holder.execution.executionId },
          query: {},
          body: null,
        }),
      );
      const revision = completed(
        await httpClient(missionOperations, f.endpoint, holder.token)[
          "execution.pinnedRevision.get"
        ]({
          params: { executionId: holder.execution.executionId },
          query: {},
          body: null,
        }),
      );
      return { setup, revision, credentials, item: payload.items[0]! };
    }
    const runtimeX = await handover(x);
    const runtimeY = await handover(y);
    const state = temporary(t);
    const root = WorkspaceRoot.open(state);
    const hostHome = temporary(t);
    mkdirSync(join(hostHome, ".agents"), { mode: PRIVATE_MODE });
    writeFileSync(join(hostHome, ".agents/AGENTS.md"), GLOBAL);

    await t.test("E07.1 software agent declaration", async () => {
      const declaration = await read<
        (typeof agentOperations)["get"]["output"]["_output"]
      >(["agent", "get", "swe@1"]);
      assert.equal(declaration.agent_name, SWE);
      const texts = declaration.prompt.layers!.flatMap(({ sources }) =>
        sources.map((source) => source.text),
      );
      for (const name of ["base.md", "swe@1.md"])
        assert.ok(
          texts.includes(
            readFileSync(
              new URL(`../../../static/prompt/${name}`, import.meta.url),
              "utf8",
            ),
          ),
        );
      assert.deepEqual(
        declaration.tools.map(({ name, source }) => ({ name, source })),
        [
          ...["read", "edit", "write", "grep", "find", "ls", "bash"].map(
            (name) => ({
              name,
              source: "builtin",
            }),
          ),
          { name: "evidence-upload", source: "host" },
        ],
      );
      assert.equal(
        declaration.configuration_schema.additionalProperties,
        false,
      );
      assert.deepEqual(declaration.configuration_schema.required, [
        "agent_provider",
        "provider",
        "credential",
        "model_identifier",
        "reasoning_effort",
      ]);
      assert.equal(declaration.enablement?.revision, FIRST_REVISION);
    });
    await t.test("E07.2 reviewer and unknown agent", async () => {
      const declaration = await read<
        (typeof agentOperations)["get"]["output"]["_output"]
      >(["agent", "get", "re@1"]);
      assert.deepEqual(
        declaration.tools.map(({ name }) => name),
        ["read", "grep", "find", "ls"],
      );
      const unknown = await kanthord(["agent", "get", "nope@1"], human);
      assert.equal(unknown.code, FAILURE_EXIT);
      assert.ok(unknown.stderr.startsWith("agent.catalog.not_found:"));
    });
    const repository = runtimeX.setup.repositories[0]!;
    await t.test("E07.3 execution setup and foreign proof", async () => {
      assert.deepEqual(runtimeX.setup.effectiveConfiguration, {
        ...DEFAULTS,
        provider: "anthropic",
        credential: "anthro-1",
      });
      assert.equal(runtimeX.setup.metadata, null);
      assert.deepEqual(runtimeX.setup.resourceBudget, {
        turns: 200,
        wallTimeMs: 7200000,
      });
      assert.deepEqual(repository, {
        bindingId: repository.bindingId,
        name: "repo",
        address: ADDRESS,
        sshIdentity: FAKE_SSH_CREDENTIAL_BODY.metadata,
        strategy: { baseBranch: "main" },
        projectPrompt: PROJECT,
        working_layer: WORKING_LAYER_ALL_ON,
      });
      assert.ok(
        runtimeX.setup.prompt.final.endsWith(framing(PromptConsumer.Worker)),
      );
      assert.ok(runtimeX.setup.prompt.final.includes(SWE_AGENT_PROMPT));
      assert.ok(!runtimeX.setup.prompt.final.includes(PROJECT));
      assert.equal(runtimeX.setup.credentialId, runtimeX.item.credential_id);
      const refused = await x.client["execution.setup.get"]({
        params: { executionId: y.execution.executionId },
        query: {},
        body: null,
      });
      assert.ok(refused.type === OperationResultType.Failure);
      assert.equal(refused.status, HttpStatus.Forbidden);
      assert.equal(refused.error.error.code, PROOF_FAILED);
    });
    const prepared = await root.prepareObjective({
      objectiveId: x.execution.nodeId,
      repository,
      transport,
      context: background,
      deadlineMs: 10000,
    });
    await t.test("E07.4 private node workspace", async () => {
      assert.equal(
        prepared.directory,
        join(state, "workspaces", x.execution.nodeId, repository.bindingId),
      );
      assert.equal(statSync(prepared.directory).mode & 0o777, PRIVATE_MODE);
      assert.equal(prepared.head, main);
      assert.equal(
        (await simpleGit(prepared.directory).branch()).current,
        `kanthord/${x.execution.nodeId}`,
      );
    });
    const provider = scriptedProvider([
      tool("bash", { command: "printf hello > hello.txt" }),
      tool("read", { path: "hello.txt" }),
      fauxAssistantMessage("done"),
    ]);
    const agent = await openNativeAgent({
      hostTools: unusedHostTools,
      setup: runtimeX.setup,
      claim: x.execution,
      nodeKind: "objective",
      method: WorkerMethod.Steps,
      credentials: runtimeX.credentials.store,
      handoverItem: runtimeX.item,
      workspace: prepared.directory,
      hostHome,
      modelRuntimeFactory: scriptedModelRuntime(provider),
      context: background,
    });
    t.after(() => agent.dispose());
    await t.test(
      "E07.5 layered inference and execution credentials",
      async () => {
        const work = renderWorkPrompt(runtimeX.revision);
        const turns = t.mock.method(agent.budget, "turnEnded");
        await agent.prompt(work);
        assert.ok(existsSync(join(prepared.directory, "hello.txt")));
        assert.equal(provider.calls.length, THREE_CALLS);
        assert.equal(turns.mock.callCount(), THREE_CALLS);
        for (const call of provider.calls) {
          assert.equal(call.apiKey, SECRET);
          assert.ok(
            call.systemPrompt?.includes(framing(PromptConsumer.Worker)),
          );
          assert.ok(
            call.systemPrompt?.includes(
              readFileSync(
                new URL("../../../static/prompt/base.md", import.meta.url),
                "utf8",
              ),
            ),
          );
          assert.ok(
            call.systemPrompt?.includes(
              readFileSync(
                new URL("../../../static/prompt/swe@1.md", import.meta.url),
                "utf8",
              ),
            ),
          );
          const text = JSON.stringify(call.messages);
          assert.ok(text.indexOf(WORKSPACE_FILE) < text.indexOf(PROJECT));
          assert.equal(text.includes(GLOBAL), false);
          assert.equal(call.systemPrompt?.includes(GLOBAL), false);
          assert.ok(
            text.indexOf(PROJECT) <
              text.indexOf(
                JSON.stringify(work.text).slice(
                  BRACKET_TRIM_OFFSET,
                  -BRACKET_TRIM_OFFSET,
                ),
              ),
          );
          assert.ok(
            text.includes(
              JSON.stringify(work.text).slice(
                BRACKET_TRIM_OFFSET,
                -BRACKET_TRIM_OFFSET,
              ),
            ),
          );
        }
        assert.deepEqual(
          agent.composition.selected.map(({ path }) => path),
          [join(prepared.directory, "AGENTS.md"), null],
        );
        assert.ok(
          agent.composition.selected.every(
            ({ owner }) => owner === REPOSITORY_OWNER,
          ),
        );
      },
    );
    const local = simpleGit(prepared.directory);
    await local.addConfig("user.name", "Runtime Test");
    await local.addConfig("user.email", "runtime@example.invalid");
    await local.add("hello.txt");
    await local.commit("write hello");
    const head = await headCommit(prepared.directory, background, 10000);
    await t.test("E07.6 ordered verification and cleanup", async () => {
      const commands = ["test -f hello.txt", "false", "true"];
      const verification = await runVerifications({
        directory: prepared.directory,
        commands,
        testedInput: {
          kind: "repository",
          bindingId: repository.bindingId,
          commit: head,
        },
        deadline: agent.budget.wallDeadline(),
        context: background,
      });
      assert.deepEqual(verification.results, [
        {
          command: commands[0],
          exitCode: SUCCESSFUL_EXIT,
          signal: null,
          timedOut: false,
        },
        {
          command: commands[1],
          exitCode: FAILURE_EXIT,
          signal: null,
          timedOut: false,
        },
      ]);
      assert.equal(verificationPassed(verification, commands), false);
      writeFileSync(join(prepared.directory, "verification-junk"), "discard");
      await discardChanges(prepared.directory, background, 10000);
      assert.equal((await local.status()).isClean(), true);
      assert.equal(
        await headCommit(prepared.directory, background, 10000),
        head,
      );
    });
    await t.test("E07.7 node branch push leaves main unchanged", async () => {
      await transport.pushNodeBranch(
        prepared.directory,
        prepared.nodeBranch,
        background,
        10000,
      );
      assert.equal(
        (
          await git.listRemote([bare, `refs/heads/${prepared.nodeBranch}`])
        ).split(/\s/)[0],
        head,
      );
      assert.equal(
        (await git.listRemote([bare, "refs/heads/main"])).split(/\s/)[0],
        main,
      );
    });
    await t.test("E07.8 lab budget stops after one turn", async () => {
      assert.deepEqual(runtimeY.setup.resourceBudget, {
        turns: SINGLE_TURN,
        wallTimeMs: 600000,
      });
      const lab = await root.prepareObjective({
        objectiveId: y.execution.nodeId,
        repository: runtimeY.setup.repositories[0]!,
        transport,
        context: background,
        deadlineMs: 10000,
      });
      const fake = scriptedProvider([
        tool("read", { path: "AGENTS.md" }),
        tool("read", { path: "AGENTS.md" }),
        tool("read", { path: "AGENTS.md" }),
      ]);
      const labAgent = await openNativeAgent({
        hostTools: unusedHostTools,
        setup: runtimeY.setup,
        claim: y.execution,
        nodeKind: "objective",
        method: WorkerMethod.Steps,
        credentials: runtimeY.credentials.store,
        handoverItem: runtimeY.item,
        workspace: lab.directory,
        hostHome,
        modelRuntimeFactory: scriptedModelRuntime(fake),
        context: background,
      });
      try {
        const turns = t.mock.method(labAgent.budget, "turnEnded");
        await labAgent.prompt(renderWorkPrompt(runtimeY.revision));
        assert.equal(labAgent.budget.exhausted(), true);
        assert.equal(fake.calls.length, SINGLE_CALL);
        assert.equal(turns.mock.callCount(), SINGLE_TURN);
      } finally {
        labAgent.dispose();
        root.release(
          root.objectiveKey(y.execution.nodeId),
          WorkspaceKind.Objective,
        );
      }
    });
    await t.test("E07.9 sweep retains only the held objective", () => {
      root.sweep(Date.now() + 8 * 24 * 3600 * 1000);
      assert.equal(existsSync(root.objectiveKey(y.execution.nodeId)), false);
      assert.equal(existsSync(root.objectiveKey(x.execution.nodeId)), true);
      root.release(
        root.objectiveKey(x.execution.nodeId),
        WorkspaceKind.Objective,
      );
    });
  },
);
