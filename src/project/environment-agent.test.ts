import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
  InMemoryCredentialStore,
  Type,
} from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { getAgentDeclaration } from "../agent/catalog.ts";
import {
  AgentErrorCode,
  type AgentView,
  type InstructionFileSource,
  InstructionFileState,
} from "../agent/contract.ts";
import { InvalidReason } from "../agent/prompt-source.ts";
import { resolveAgentPrompt } from "../agent/prompt-files.ts";
import { REDACTION_LOG_MESSAGE } from "../agent/hooks/sensitive-text-redaction.ts";
import { SensitiveRule } from "../agent/sensitive-text.ts";
import { loadPi } from "../agent/pi.ts";
import {
  scriptedProvider,
  type ScriptedProvider,
} from "../agent/test-support.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { EnvironmentSource } from "../kernel/devcontainer.ts";
import { FacilityError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  redactingLogger,
  stopAfter,
  temporary,
} from "../kernel/test-support.ts";
import { isString } from "../kernel/values.ts";
import { createModelRuntime, resolveModel } from "../llm/model-connector.ts";
import { PROJECT_SERVICE_NAME } from "./contract.ts";
import {
  PE_AGENT_NAME,
  EnvironmentAgent,
  type EnvironmentModelRuntimeFactory,
  EnvironmentSessionEnd,
  type EnvironmentSessionHandle,
  type EnvironmentSessionInput,
} from "./environment-agent.ts";
import { EnvironmentTarget, type ProofFile } from "./environment-state.ts";

const TEST_TIMEOUT_MS = 60000;
const ROLE_TOOL_RESULT = "toolResult";
const ROLE_USER = "user";
const NO_CALLS = 0;
const ONE_CALL = 1;
const SECRET_FILE = "secret.txt";
const ANTHROPIC = "anthropic";
const MODEL = "claude-sonnet-4-5";
const CREDENTIAL = "env-key";
const PACKAGE_TEXT = "fixture-package-text";
const OUTSIDE_TEXT = "text-outside-the-checkout";
const LINKED_TEXT = "text-behind-the-link";
const WRITE_TOOL = "environment_write";
const FINISH_TOOL = "environment_finish";
const BINDING_NAME = "app";
const BINDING_ID = "binding_01";
const ENV_BINDING_TEXT = "Use the pinned toolchain image.";
const SWE_TEXT = "Prefer small commits.";
const INVALID_OVERRIDE_TEXT = "bell\u0007";
const COMMIT = "0123456789abcdef";
const INSTRUCTION_PATH = "AGENTS.md";
const INSTRUCTION_TEXT = "Write every name outside the code in snake_case.";
const REPOSITORY_TEXT = "A test file sits beside its source file.";
const TAIL = "npm ERR! missing script: build";
const FAILURE_CLASS = "setup_failed";
const ESCAPES = [
  { tool: "read", path: "/etc/passwd" },
  { tool: "read", path: "~/.ssh/id_ed25519" },
  { tool: "read", path: "../outside.txt" },
  { tool: "ls", path: "link" },
];

const unavailable: AgentView = {
  defaults: null,
  effective: null,
  chain: [],
  active_position: null,
  cooling: null,
  valid: false,
  issues: [{ path: [], code: "agent.configuration.unavailable" }],
};
const available: AgentView = {
  defaults: null,
  effective: {
    agent_provider: "primary",
    provider: ANTHROPIC,
    credential: CREDENTIAL,
    model_identifier: MODEL,
    reasoning_effort: "off",
  },
  chain: [],
  active_position: 0,
  cooling: null,
  valid: true,
  issues: [],
};

const failure: ProofFile = {
  digest: "sum",
  outcome: "failed",
  class: FAILURE_CLASS,
  origin: "onboarding",
  execution_id: null,
  command: "npm run build",
  exit_code: 1,
  tail: TAIL,
  reproduce: null,
  checks: [{ command: "make test", exit_code: 2 }],
  repairs: 0,
  ended_at: 1,
  commit: "c1",
};

function text(message: { content: unknown }): string {
  return isString(message.content)
    ? message.content
    : (message.content as { text: string }[])
        .map((part) => part.text)
        .join("\n");
}

function writeTool(): ToolDefinition {
  return {
    name: WRITE_TOOL,
    label: WRITE_TOOL,
    description: "Store one document.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "stored" }], details: null };
    },
  } as unknown as ToolDefinition;
}

function finishTool(handle: EnvironmentSessionHandle): ToolDefinition {
  return {
    name: FINISH_TOOL,
    label: FINISH_TOOL,
    description: "End the session.",
    parameters: Type.Object({}),
    async execute() {
      handle.end();
      return { content: [{ type: "text", text: "ended" }], details: null };
    },
  } as unknown as ToolDefinition;
}

function fixture(
  t: TestContext,
  script: FauxResponseStep[],
  state: {
    view: AgentView;
    onExport?: () => void;
    promptDirectory?: string;
    instructionFile?: InstructionFileSource;
  } = { view: available },
) {
  const stateDirectory = temporary(t);
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  const provider: ScriptedProvider = scriptedProvider(script);
  const identity = testServiceIdentity(PROJECT_SERVICE_NAME);
  const credentials = new InMemoryCredentialStore();
  const logLines: string[] = [];
  const record = {
    factoryCalls: 0,
    exports: [] as {
      bindingId: string;
      commit: string;
      directory: string;
    }[],
    authorized: [] as string[],
    sessionIds: [] as string[],
    checkouts: [] as string[],
    outside: "",
    instructionReads: [] as string[],
  };
  const modelRuntimeFactory: EnvironmentModelRuntimeFactory = async (input) => {
    record.factoryCalls++;
    const runtime = await createModelRuntime(await loadPi(), input);
    runtime.registerNativeProvider(provider.provider);
    return { runtime, model: resolveModel(runtime, input.configuration) };
  };
  const agent = new EnvironmentAgent({
    store,
    logger: redactingLogger(logLines),
    stateDirectory,
    hostHome: temporary(t),
    identity,
    agentView: (_tx, name) => {
      assert.equal(name, PE_AGENT_NAME);
      return state.view;
    },
    serverAgentCredentials: (input) => {
      store.transaction((tx) => {
        const answer = input.authorize(tx, input.requester(), input.session_id);
        record.authorized.push(answer.credential);
      });
      void credentials.modify(ANTHROPIC, async () => ({
        type: "api_key",
        key: "scripted-key",
      }));
      return credentials;
    },
    composePrompt: (agentName, context) =>
      resolveAgentPrompt({
        agent: getAgentDeclaration(agentName)!,
        directory: state.promptDirectory ?? null,
        workbench: false,
        context,
      }),
    repositoryPromptsOf: (_tx, bindingId) =>
      bindingId === BINDING_ID
        ? {
            binding_id: BINDING_ID,
            name: BINDING_NAME,
            prompts: {
              ...(state.instructionFile === undefined
                ? {}
                : {
                    instruction_file: INSTRUCTION_PATH,
                    repository: REPOSITORY_TEXT,
                  }),
              agents: { [PE_AGENT_NAME]: ENV_BINDING_TEXT, "swe@1": SWE_TEXT },
            },
          }
        : null,
    instructionFileOf: async (bindingId, commit) => {
      assert.equal(bindingId, BINDING_ID);
      record.instructionReads.push(commit);
      return state.instructionFile ?? null;
    },
    templates: async () => SHIPPED_TEMPLATES,
    exportRepository: async (bindingId, commit, directory) => {
      record.exports.push({ bindingId, commit, directory });
      state.onExport?.();
      mkdirSync(join(directory, "src"), { recursive: true });
      writeFileSync(join(directory, "package.json"), PACKAGE_TEXT);
      const outside = join(dirname(directory), "outside.txt");
      writeFileSync(outside, OUTSIDE_TEXT);
      const linked = join(dirname(directory), "linked");
      mkdirSync(linked);
      writeFileSync(join(linked, SECRET_FILE), LINKED_TEXT);
      symlinkSync(linked, join(directory, "link"));
    },
    modelRuntimeFactory,
  });
  const context = new CancellationContext(background);
  const input = (
    tools: (handle: EnvironmentSessionHandle) => ToolDefinition[] = (
      handle,
    ) => {
      record.sessionIds.push(handle.session_id);
      record.checkouts.push(handle.checkout);
      return [writeTool()];
    },
  ): EnvironmentSessionInput => ({
    project_id: "project_01",
    binding_id: BINDING_ID,
    binding_name: BINDING_NAME,
    resource_identity: "github:acme/app",
    commit: COMMIT,
    target: EnvironmentTarget.Image,
    source: EnvironmentSource.Repository,
    document: null,
    failure,
    context,
    tools,
  });
  const runDirectories = () => {
    const directory = join(stateDirectory, "environments");
    return existsSync(directory)
      ? readdirSync(directory).filter((name) => name.startsWith("run-"))
      : [];
  };
  return {
    agent,
    provider,
    record,
    context,
    input,
    runDirectories,
    state,
    logLines,
  };
}

function toolResults(provider: ScriptedProvider) {
  const last = provider.calls.at(-1)!;
  return last.messages.filter((message) => message.role === ROLE_TOOL_RESULT);
}

test(
  "no enablement answers not_enabled with no model call, no export and no directory",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = fixture(t, [], { view: unavailable });
    assert.equal(f.agent.enabled(), false);
    assert.equal(
      await f.agent.run(f.input()),
      EnvironmentSessionEnd.NotEnabled,
    );
    assert.equal(f.record.factoryCalls, NO_CALLS);
    assert.deepEqual(f.record.exports, []);
    assert.deepEqual(f.runDirectories(), []);
  },
);

test(
  "an enabled agent reads a checkout file and ends",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = fixture(t, [
      fauxAssistantMessage([fauxToolCall("read", { path: "package.json" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    assert.equal(await f.agent.run(f.input()), EnvironmentSessionEnd.Ended);
    const results = toolResults(f.provider);
    assert.ok(results.length);
    assert.ok(text(results[0]!).includes(PACKAGE_TEXT));
    assert.deepEqual(f.record.authorized, [CREDENTIAL]);
  },
);

test(
  "pe@1 reads the instruction file at the commit of its run before the stored repository prompt",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = fixture(t, [fauxAssistantMessage("done")], {
      view: available,
      instructionFile: {
        path: INSTRUCTION_PATH,
        commit: COMMIT,
        state: InstructionFileState.Present,
        reason: null,
        text: INSTRUCTION_TEXT,
      },
    });
    assert.equal(await f.agent.run(f.input()), EnvironmentSessionEnd.Ended);
    assert.deepEqual(f.record.instructionReads, [COMMIT]);
    assert.ok(
      f.provider.calls[0]!.systemPrompt?.includes(
        `Repository prompt of repository ${BINDING_NAME}, file ${INSTRUCTION_PATH}:\n\n${INSTRUCTION_TEXT}\n\nRepository prompt of repository ${BINDING_NAME}, set in KanthorD:\n\n${REPOSITORY_TEXT}\n\nBinding prompt of repository ${BINDING_NAME}:\n\n${ENV_BINDING_TEXT}`,
      ),
    );
  },
);

test(
  "an invalid instruction file answers 409 source_invalid with no model call",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = fixture(t, [fauxAssistantMessage("done")], {
      view: available,
      instructionFile: {
        path: INSTRUCTION_PATH,
        commit: COMMIT,
        state: InstructionFileState.Invalid,
        reason: InvalidReason.ControlCharacter,
        text: null,
      },
    });
    await assert.rejects(f.agent.run(f.input()), {
      status: HttpStatus.Conflict,
      code: AgentErrorCode.PromptSourceInvalid,
      details: {
        part: "instruction_file",
        name: BINDING_NAME,
        binding_id: BINDING_ID,
        path: INSTRUCTION_PATH,
        commit: COMMIT,
        reason: InvalidReason.ControlCharacter,
      },
    });
    assert.equal(f.provider.calls.length, NO_CALLS);
  },
);

test(
  "an invalid override file answers 409 template_invalid with no model call",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const promptDirectory = temporary(t);
    writeFileSync(
      join(promptDirectory, `${PE_AGENT_NAME}.md`),
      INVALID_OVERRIDE_TEXT,
    );
    const f = fixture(t, [fauxAssistantMessage("done")], {
      view: available,
      promptDirectory,
    });
    await assert.rejects(f.agent.run(f.input()), {
      status: HttpStatus.Conflict,
      code: AgentErrorCode.PromptTemplateInvalid,
      details: {
        file: `${PE_AGENT_NAME}.md`,
        path: join(promptDirectory, `${PE_AGENT_NAME}.md`),
        reason: InvalidReason.ControlCharacter,
      },
    });
    assert.equal(f.provider.calls.length, NO_CALLS);
  },
);

test(
  "an abort during the model call ends the run as aborted and removes the directory",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const holder: { context?: CancellationContext } = {};
    const f = fixture(t, [
      async (_context, options) => {
        holder.context?.cancel();
        if (!options!.signal!.aborted) await once(options!.signal!, "abort");
        return fauxAssistantMessage("late");
      },
    ]);
    holder.context = f.context;
    assert.equal(await f.agent.run(f.input()), EnvironmentSessionEnd.Aborted);
    assert.deepEqual(f.runDirectories(), []);
  },
);

test(
  "end() from a custom tool ends the run after the tool answer",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = fixture(t, [
      fauxAssistantMessage([fauxToolCall(FINISH_TOOL, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("never sent"),
    ]);
    assert.equal(
      await f.agent.run(f.input((handle) => [finishTool(handle)])),
      EnvironmentSessionEnd.Ended,
    );
    assert.equal(f.provider.calls.length, ONE_CALL);
    assert.deepEqual(f.runDirectories(), []);
  },
);

test(
  "a path outside the checkout answers a tool error that names the path",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = fixture(t, [
      ...ESCAPES.map(({ tool, path }) =>
        fauxAssistantMessage([fauxToolCall(tool, { path })], {
          stopReason: "toolUse",
        }),
      ),
      fauxAssistantMessage("done"),
    ]);
    assert.equal(await f.agent.run(f.input()), EnvironmentSessionEnd.Ended);
    const results = toolResults(f.provider);
    assert.deepEqual(
      results.map((result) => (result as { isError: boolean }).isError),
      [true, true, true, true],
    );
    results.forEach((result, index) => {
      const body = text(result);
      assert.ok(body.includes(ESCAPES[index]!.path));
      assert.ok(!body.includes(OUTSIDE_TEXT));
      assert.ok(!body.includes(LINKED_TEXT));
      assert.ok(!body.includes(SECRET_FILE));
    });
  },
);

test(
  "the pe@1 session redacts its JSON failure, keeps the confinement and logs the counts after drive",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fakeKey = ["AKIA", "KANTHORDCANARY01"].join("");
    const outside = ESCAPES[0]!;
    const f = fixture(t, [
      fauxAssistantMessage(
        [fauxToolCall(outside.tool, { path: outside.path })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const input = {
      ...f.input(),
      failure: { ...failure, tail: `${TAIL}\nAWS_KEY=${fakeKey}` },
    };
    assert.equal(await f.agent.run(input), EnvironmentSessionEnd.Ended);
    assert.ok(!JSON.stringify(f.provider.calls).includes(fakeKey));
    const user = f.provider.calls[0]!.messages.find(
      (message) => message.role === ROLE_USER,
    )!;
    assert.ok(
      text(user).includes(`<redacted:${SensitiveRule.AwsAccessKeyId}:`),
    );
    const [result] = toolResults(f.provider);
    assert.equal((result as { isError: boolean }).isError, true);
    assert.ok(!text(result!).includes(OUTSIDE_TEXT));
    const records = f.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === REDACTION_LOG_MESSAGE);
    assert.equal(records.length, ONE_CALL);
    assert.equal(records[0]!.session_id, f.record.sessionIds[0]);
    assert.deepEqual(records[0]!.redaction_rules, [
      SensitiveRule.AwsAccessKeyId,
    ]);
  },
);

test(
  "a view that is no longer valid refuses the credential release and removes the directory",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state: { view: AgentView; onExport?: () => void } = {
      view: available,
    };
    const f = fixture(t, [fauxAssistantMessage("done")], state);
    state.onExport = () => {
      state.view = unavailable;
    };
    await assert.rejects(f.agent.run(f.input()), FacilityError);
    assert.equal(f.record.factoryCalls, NO_CALLS);
    assert.deepEqual(f.runDirectories(), []);
  },
);
