import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { PI_DIRECTORY_NAME, usePiDirectory } from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { CancellationContext } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import {
  hostEnvironment,
  temporary,
  temporaryDirectory,
} from "../../kernel/test-support.ts";
import { HostTool } from "../../worker/contract.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  repositorySetup,
  scriptedModelRuntime,
  scriptedProvider,
  type ScriptedProvider,
  task,
} from "../../worker/unit/test-support.ts";
import {
  EndReason,
  PI_AUTH_FILE,
  RunEndKind,
  TasksErrorCode,
  TasksExit,
} from "../worker/index.ts";
import { missionOperations } from "../../mission/contract.ts";
import { ExitCode } from "./constants.ts";
import { runInProcess } from "./test-support.ts";
import {
  stopOnSignal,
  type TasksCommandIo,
  tasksRun,
  type TasksRunOptions,
} from "./worker-tasks.ts";

const PI_ROOT = temporaryDirectory();
const PI_DIRECTORY = join(PI_ROOT, PI_DIRECTORY_NAME);
process.on("exit", () => rmSync(PI_ROOT, { recursive: true, force: true }));
installPiTools({ directory: PI_DIRECTORY });
usePiDirectory(PI_DIRECTORY);

const CREDENTIAL_CANARY = "canary-credential-value-0123456789";
const PASS_VALUE = "canary-pass-value-0123456789";
const PASS_NAME = "TASKS_CANARY";
const UNPASSED_NAME = "TASKS_UNPASSED";
const UNPASSED_VALUE = "unpassed-value-0123456789";
const SEED_FILE = "seed.json";
const TEST_TIMEOUT_MS = 120000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MODE_BITS = 0o777;
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const OUTPUT_FILES = [
  "result.json",
  "context.json",
  "progress.json",
  "metrics.json",
  "outbox.json",
  "spans.jsonl",
];
const REFUSED_KEYS = ["credentials", "sshAccess"];
const OBJECT_TYPE = "object";
const ROUTE_PASSED = "passed";
const CLEAN_OUTPUT = "";
const BARE_VALUE = "true";
const ONE_UPLOAD = 1;
const ZERO_BYTE = 0;
const NO_CALLS = 0;

interface SeedFixture {
  root: string;
  seedFolder: string;
  source: string;
  bindingId: string;
  head: string;
  seed: Record<string, unknown>;
}

async function sourceRepository(root: string): Promise<{
  source: string;
  head: string;
}> {
  const source = join(root, "source");
  mkdirSync(source);
  const git = simpleGit(source);
  await git.raw(["init", "-b", "main"]);
  writeFileSync(join(source, "file"), "base");
  await git.add("file");
  await git.raw([...IDENTITY, "commit", "-m", "base"]);
  return { source, head: (await git.revparse(["HEAD"])).trim() };
}

function revisionOf(nodeId: string, tasks: ReturnType<typeof task>[]) {
  return {
    node_id: nodeId,
    filename: "implement.md",
    revision: 1,
    reason: "seed",
    actor: { kind: "human", account: "ulrich", name: "Ulrich" },
    created_at: 1,
    content: {
      name: "implement",
      requirement: "implement",
      criterion: "implement",
      verifications: ["true"],
      bindings: [],
      intent: "implement",
      tags: [],
      external_links: [],
    },
    tasks,
    change: {
      write: "import",
      previous_revision: null,
      changed_fields: [],
    },
    pinned_by_attempts: [1],
  };
}

async function seedFixture(
  t: TestContext,
  shape: (seed: Record<string, unknown>) => void = () => {},
): Promise<SeedFixture> {
  const root = temporary(t);
  const { source, head } = await sourceRepository(root);
  const repository = repositorySetup();
  const setup = anthropicSetup({ repositories: [repository] });
  const nodeId = createIdentity("node");
  const seed: Record<string, unknown> = {
    claim: {
      execution_id: setup.execution_id,
      node_id: nodeId,
      attempt: 1,
      pinned_revision: 1,
      node_branch: `kanthord/${nodeId}`,
      created_at: 1000,
      expired_at: 1000 + 3600000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
    },
    setup,
    revision: revisionOf(nodeId, [task("work", "grep -q good file")]),
    heads: { [repository.binding_id]: head },
  };
  shape(seed);
  const seedFolder = join(root, "seed");
  mkdirSync(seedFolder);
  writeFileSync(join(seedFolder, SEED_FILE), JSON.stringify(seed));
  return {
    root,
    seedFolder,
    source,
    bindingId: repository.binding_id,
    head,
    seed,
  };
}

interface CommandRun {
  io: TasksCommandIo;
  stdout: string[];
  stderr: string[];
}

function apiKeyInput(key = CREDENTIAL_CANARY): Buffer {
  return Buffer.from(
    JSON.stringify({
      provider_id: "anthropic",
      credential: { type: "api_key", key },
    }),
  );
}

function commandRun(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  overrides: Partial<TasksCommandIo> = {},
): CommandRun {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd: fixture.root,
      shellEnv: hostEnvironment(),
      stdinTerminal: false,
      readStdin: () => apiKeyInput(),
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      modelRuntimeFactory: scriptedModelRuntime(provider),
      stop: new CancellationContext(),
      ...overrides,
    },
  };
}

function runOptions(
  fixture: SeedFixture,
  options: Partial<TasksRunOptions> = {},
): TasksRunOptions {
  return {
    credentialStdin: true,
    tree: [`${fixture.bindingId}=${fixture.source}`],
    passEnv: [],
    unit: [],
    output: join(fixture.root, "out"),
    ...options,
  };
}

function writeGood() {
  return fauxAssistantMessage(
    fauxToolCall("write", { path: "file", content: "good" }),
    { stopReason: "toolUse" },
  );
}

function readJson(folder: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(folder, name), "utf8")) as Record<
    string,
    unknown
  >;
}

function filesOf(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesOf(path) : [path];
  });
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== OBJECT_TYPE) return [];
  return Object.entries(value as object).flatMap(([key, item]) => [
    key,
    ...keysOf(item),
  ]);
}

async function diagnosticOf(
  run: Promise<unknown>,
): Promise<{ code: string; fields: unknown }> {
  try {
    await run;
  } catch (error) {
    const coded = error as { code: string; fields: unknown };
    return { code: coded.code, fields: coded.fields };
  }
  return assert.fail("The run gave no diagnostic.");
}

suite("worker tasks run", () => {
  test(
    "a minimal seed fills every default, completes and writes each output file",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      assert.deepEqual(Object.keys(fixture.seed), [
        "claim",
        "setup",
        "revision",
        "heads",
      ]);
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const output = join(fixture.root, "out");
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { verify: true }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      assert.equal(statSync(output).mode & MODE_BITS, PRIVATE_DIRECTORY_MODE);
      for (const name of [...OUTPUT_FILES, "uploads", "state"])
        assert.ok(existsSync(join(output, name)), name);
      const result = readJson(output, "result.json");
      assert.equal(result.end, RunEndKind.Completed);
      assert.equal(result.exit_code, TasksExit.Success);
      assert.ok(
        (result.checks as { passed: boolean }[]).every((check) => check.passed),
      );
      const context = readJson(output, "context.json") as {
        input: {
          plan: { pending: { task: { id: string } }[] };
          affectedTests: unknown[];
          until: string | null;
        };
        result: { route: { kind: string } };
      };
      const [work] = (fixture.seed.revision as { tasks: { id: string }[] })
        .tasks;
      assert.deepEqual(
        context.input.plan.pending.map((entry) => entry.task.id),
        [work!.id],
      );
      assert.deepEqual(context.input.affectedTests, []);
      assert.equal(context.input.until, null);
      assert.equal(context.result.route.kind, ROUTE_PASSED);
      assert.deepEqual(JSON.parse(run.stdout.join("")), {
        output,
        end: RunEndKind.Completed,
        exit_code: TasksExit.Success,
      });
    },
  );

  test(
    "--tree leaves the source repository unchanged, and an agent git push origin fails",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const source = simpleGit(fixture.source);
      const before = await source.raw(["show-ref"]);
      const provider = scriptedProvider([
        fauxAssistantMessage(
          fauxToolCall("bash", {
            command:
              "git push origin HEAD:refs/heads/agent-push; echo push_exit=$?",
          }),
          { stopReason: "toolUse" },
        ),
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      assert.equal(await source.raw(["show-ref"]), before);
      assert.equal(await source.raw(["status", "--porcelain"]), CLEAN_OUTPUT);
      assert.equal((await source.revparse(["HEAD"])).trim(), fixture.head);
      const mirror = join(
        fixture.root,
        "out",
        "state",
        "origin",
        `${fixture.bindingId}.git`,
      );
      assert.equal(
        (await simpleGit(mirror).raw(["config", "core.bare"])).trim(),
        BARE_VALUE,
      );
      assert.equal(
        await simpleGit(mirror)
          .raw(["show-ref", "refs/heads/agent-push"])
          .catch(() => CLEAN_OUTPUT),
        CLEAN_OUTPUT,
      );
      const pushed = JSON.stringify(provider.calls.at(1)?.messages);
      assert.match(pushed, /push_exit=(?!0)[0-9]+/);
    },
  );

  test(
    "agent bash receives a --pass-env variable, and no other variable of the host process",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      process.env[UNPASSED_NAME] = UNPASSED_VALUE;
      t.after(() => delete process.env[UNPASSED_NAME]);
      const provider = scriptedProvider([
        fauxAssistantMessage(
          fauxToolCall("bash", {
            command: `echo "unpassed=$${UNPASSED_NAME}"; test -n "$${PASS_NAME}" && echo passed=yes; echo "home=$HOME"`,
          }),
          { stopReason: "toolUse" },
        ),
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider, {
        shellEnv: { ...hostEnvironment(), [PASS_NAME]: PASS_VALUE },
      });
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { passEnv: [PASS_NAME] }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const shown = JSON.stringify(provider.calls.at(1)?.messages.at(-1));
      assert.match(shown, /unpassed=\\n/);
      assert.match(shown, /passed=yes/);
      assert.match(shown, /home=[^\\]*\/out\/state\/home/);
    },
  );

  test(
    "the canary values of the credential and of --pass-env reach no output file and no standard stream",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const provider = scriptedProvider([
        fauxAssistantMessage(
          fauxToolCall("bash", {
            command: `echo "$${PASS_NAME}" > evidence.txt; cat evidence.txt`,
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(HostTool.EvidenceUpload, { path: "evidence.txt" }),
          { stopReason: "toolUse" },
        ),
        writeGood(),
        fauxAssistantMessage(`done ${CREDENTIAL_CANARY} ${PASS_VALUE}`),
      ]);
      const run = commandRun(fixture, provider, {
        shellEnv: { ...hostEnvironment(), [PASS_NAME]: PASS_VALUE },
      });
      const output = join(fixture.root, "out");
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { passEnv: [PASS_NAME] }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const outbox = readJson(output, "outbox.json") as unknown as {
        operation: string;
      }[];
      assert.ok(
        outbox.some(
          (entry) =>
            entry.operation === missionOperations["evidence.submit"].id,
        ),
      );
      const uploads = filesOf(join(output, "uploads"));
      assert.equal(uploads.length, ONE_UPLOAD);
      const files = [
        ...OUTPUT_FILES.map((name) => join(output, name)),
        ...uploads,
      ];
      const texts = [
        ...files.map((file) => readFileSync(file, "utf8")),
        run.stdout.join(""),
        run.stderr.join(""),
      ];
      for (const canary of [CREDENTIAL_CANARY, PASS_VALUE])
        for (const [index, text] of texts.entries())
          assert.ok(!text.includes(canary), `${files[index] ?? "stream"}`);
      assert.ok(readFileSync(uploads[0]!, "utf8").includes("[redacted]"));
      const keys = keysOf(readJson(output, "context.json"));
      for (const key of REFUSED_KEYS) assert.ok(!keys.includes(key), key);
    },
  );

  test(
    "a hand-written seed with no prompt and no templates runs with --system-prompt and --templates",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t, (seed) => {
        const setup = seed.setup as {
          templates?: unknown;
          agents: { prompt: { final?: string } }[];
        };
        delete setup.templates;
        delete setup.agents[0]!.prompt.final;
      });
      const refused = commandRun(fixture, scriptedProvider([]));
      assert.equal(
        (
          await diagnosticOf(
            tasksRun(fixture.seedFolder, runOptions(fixture), refused.io),
          )
        ).code,
        TasksErrorCode.SeedInvalid,
      );
      const prompt = join(fixture.root, "system.md");
      writeFileSync(prompt, "Local system prompt marker.");
      const templates = join(fixture.root, "templates");
      mkdirSync(templates);
      writeFileSync(join(templates, "work.md"), "Local work template marker.");
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, {
          systemPrompt: "system.md",
          templates: "templates",
        }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const [first] = provider.calls;
      assert.match(String(first?.systemPrompt), /Local system prompt marker\./);
      assert.match(
        JSON.stringify(first?.messages),
        /Local work template marker\./,
      );
      const result = readJson(join(fixture.root, "out"), "result.json");
      assert.deepEqual(result.overrides, {
        system_prompt: true,
        templates: true,
      });
    },
  );

  test(
    "SIGINT stops the run with worker_stopped and exit 2",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const stop = new CancellationContext();
      const release = stopOnSignal(stop);
      t.after(release);
      const provider = scriptedProvider([
        () => {
          process.emit("SIGINT");
          return fauxAssistantMessage("interrupted");
        },
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider, { stop });
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.Stopped);
      const result = readJson(join(fixture.root, "out"), "result.json") as {
        end: string;
        stop: { reason: string };
      };
      assert.equal(result.end, RunEndKind.Stop);
      assert.equal(result.stop.reason, EndReason.WorkerStopped);
    },
  );

  test(
    "an unknown error ends the run with failed, exit 5 and internal_error",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const stderr = run.io.stderr;
      run.io.stderr = (text) => {
        if (text.includes('"task started"')) throw new Error("unknown failure");
        stderr(text);
      };
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.InternalError);
      assert.equal(JSON.parse(run.stdout.join("")).end, RunEndKind.Failed);
      assert.match(
        run.stderr.join(""),
        new RegExp(TasksErrorCode.InternalError),
      );
    },
  );
});

suite("worker tasks run credentials", () => {
  test("live mode without --credential-stdin and a credential option exit with 1 before any read", async (t) => {
    const fixture = await seedFixture(t);
    const env = { ...hostEnvironment(), XDG_CONFIG_HOME: temporary(t) };
    const live = await runInProcess(
      ["worker", "tasks", "run", fixture.seedFolder],
      env,
    );
    assert.equal(live.code, ExitCode.Failure);
    assert.match(live.stderr, new RegExp(TasksErrorCode.ModeInvalid));
    const option = await runInProcess(
      [
        "worker",
        "tasks",
        "run",
        fixture.seedFolder,
        "--credential",
        CREDENTIAL_CANARY,
      ],
      env,
    );
    assert.notEqual(option.code, ExitCode.Success);
    assert.ok(!option.stdout.includes(CREDENTIAL_CANARY));
    assert.ok(!existsSync(join(fixture.root, "out")));
  });

  test("a terminal, a malformed object, another provider and an expiring token are refused before the output folder exists", async (t) => {
    const fixture = await seedFixture(t);
    const output = join(fixture.root, "out");
    const refusals: [Partial<TasksCommandIo>, string, string][] = [
      [{ stdinTerminal: true }, TasksErrorCode.CredentialInvalid, "stdin"],
      [
        { readStdin: () => Buffer.from("{not json") },
        TasksErrorCode.CredentialInvalid,
        "credential",
      ],
      [
        {
          readStdin: () =>
            Buffer.from(
              JSON.stringify({
                provider_id: "openai",
                credential: { type: "api_key", key: CREDENTIAL_CANARY },
              }),
            ),
        },
        TasksErrorCode.CredentialInvalid,
        "provider_id",
      ],
      [
        {
          readStdin: () =>
            Buffer.from(
              JSON.stringify({
                provider_id: "anthropic",
                credential: {
                  type: "oauth",
                  access: CREDENTIAL_CANARY,
                  refresh: CREDENTIAL_CANARY,
                  expires: Date.now() + 60000,
                },
              }),
            ),
        },
        TasksErrorCode.CredentialExpiring,
        "",
      ],
    ];
    for (const [overrides, code, field] of refusals) {
      const run = commandRun(fixture, scriptedProvider([]), overrides);
      const refusal = await diagnosticOf(
        tasksRun(fixture.seedFolder, runOptions(fixture), run.io),
      );
      assert.equal(refusal.code, code);
      if (field) assert.deepEqual(refusal.fields, [["field", field]]);
      assert.ok(!JSON.stringify(refusal).includes(CREDENTIAL_CANARY));
      assert.ok(!existsSync(output));
    }
  });

  test("the standard input buffer is zero after the parse", async (t) => {
    const fixture = await seedFixture(t);
    const input = apiKeyInput();
    const run = commandRun(fixture, scriptedProvider([]), {
      readStdin: () => input,
    });
    await diagnosticOf(
      tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { passEnv: ["UNSET_TASKS_VARIABLE"] }),
        run.io,
      ),
    );
    const parsed = commandRun(fixture, scriptedProvider([]), {
      readStdin: () => input,
      modelRuntimeFactory: async () => {
        throw new Error("stop after the parse");
      },
    });
    await tasksRun(fixture.seedFolder, runOptions(fixture), parsed.io);
    assert.ok(input.every((byte) => byte === ZERO_BYTE));
  });

  test("--pass-env refuses a credential variable of a provider", async (t) => {
    const fixture = await seedFixture(t);
    const run = commandRun(fixture, scriptedProvider([]), {
      shellEnv: { ...hostEnvironment(), ANTHROPIC_API_KEY: CREDENTIAL_CANARY },
    });
    const refusal = await diagnosticOf(
      tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { passEnv: ["ANTHROPIC_API_KEY"] }),
        run.io,
      ),
    );
    assert.equal(refusal.code, TasksErrorCode.OptionInvalid);
  });

  test(
    "pi reads the standard input credential from a frozen store, with an environment key and no auth.json",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider, {
        shellEnv: {
          ...hostEnvironment(),
          ANTHROPIC_API_KEY: "environment-key-0123456789",
        },
      });
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      assert.ok(provider.calls.length > NO_CALLS);
      for (const call of provider.calls)
        assert.equal(call.apiKey, CREDENTIAL_CANARY);
      assert.ok(!existsSync(join(PI_DIRECTORY, PI_AUTH_FILE)));
      writeFileSync(join(PI_DIRECTORY, PI_AUTH_FILE), "{}");
      t.after(() => rmSync(join(PI_DIRECTORY, PI_AUTH_FILE), { force: true }));
      const refused = commandRun(fixture, scriptedProvider([]));
      const refusal = await diagnosticOf(
        tasksRun(
          fixture.seedFolder,
          runOptions(fixture, { force: true }),
          refused.io,
        ),
      );
      assert.equal(refusal.code, TasksErrorCode.CredentialInvalid);
      assert.deepEqual(refusal.fields, [["field", PI_AUTH_FILE]]);
    },
  );
});
