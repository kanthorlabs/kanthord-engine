import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { suite, test } from "node:test";
import { simpleGit } from "simple-git";
import { PI_DIRECTORY_NAME, usePiDirectory } from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { CancellationContext } from "../../kernel/context.ts";
import { HostTool } from "../../worker/contract.ts";
import { digest } from "../../kernel/json.ts";
import {
  hostEnvironment,
  temporary,
  temporaryDirectory,
} from "../../kernel/test-support.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
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
import { ExitCode } from "./constants.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import {
  apiKeyInput,
  type CommandRun,
  CREDENTIAL_CANARY,
  diagnosticOf,
  OUTPUT_FILES,
  PASS_NAME,
  PASS_VALUE,
  readJson,
  runOptions,
  seedFixture,
  type SeedFixture,
  commandRun as sharedCommandRun,
  TEST_TIMEOUT_MS,
  writeGood,
} from "./tasks-test-support.ts";
import { runInProcess } from "./test-support.ts";
import { stopOnSignal, type TasksCommandIo, tasksRun } from "./worker-tasks.ts";

const PI_ROOT = temporaryDirectory();
const STOP_CODE_CHECK = 7;
const AFFECTED_DECLARATION_FILE = ".kanthord/affected-tests.json";
const FAILED_SETUP = {
  source: EnvironmentSource.Detected,
  document: { postCreateCommand: "exit 3" },
};

async function declareInvalidAffected(fixture: SeedFixture): Promise<void> {
  const declaration = join(fixture.source, AFFECTED_DECLARATION_FILE);
  mkdirSync(dirname(declaration));
  writeFileSync(
    declaration,
    JSON.stringify({ version: 1, command: " ", gate_files: [] }),
  );
  const git = simpleGit(fixture.source);
  await git.add(AFFECTED_DECLARATION_FILE);
  await git.raw([...COMMIT_IDENTITY, "commit", "-q", "-m", "declare"]);
}
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Seed",
  "-c",
  "user.email=seed@example.com",
];
const PI_DIRECTORY = join(PI_ROOT, PI_DIRECTORY_NAME);
process.on("exit", () => rmSync(PI_ROOT, { recursive: true, force: true }));
installPiTools({ directory: PI_DIRECTORY });
usePiDirectory(PI_DIRECTORY);

const UNPASSED_NAME = "TASKS_UNPASSED";
const UNPASSED_VALUE = "unpassed-value-0123456789";
const PRIVATE_DIRECTORY_MODE = 0o700;
const MODE_BITS = 0o777;
const ROUTE_PASSED = "passed";
const CLEAN_OUTPUT = "";
const BARE_VALUE = "true";
const NO_CALLS = 0;
const ZERO_BYTE = 0;
const CLAIM_WATCH_INTERVAL_MS = 60000;
const CLAIM_LENGTH_MS = 3600000;
const START_TOLERANCE_MS = 60000;
const SLOW_WRITER_MS = 500;
const CLEAN_TREES_CHECK = 5;
const ATTACKER_URL = "http://attacker.invalid/v1";
const RELEASE_GATE_LOOP = "release_gate";
const TASKS_FAILED = "tasks failed";
const KEPT_TEXT = "kept";
const DIAGNOSTIC_END = "diagnostic";
const UNIT_COMPLETE = "complete";

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function commandRun(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  overrides: Partial<TasksCommandIo> = {},
): CommandRun {
  return sharedCommandRun(fixture, provider, {
    piDirectory: PI_DIRECTORY,
    ...overrides,
  });
}

function bash(command: string) {
  return fauxAssistantMessage(fauxToolCall("bash", { command }), {
    stopReason: "toolUse",
  });
}

function toolResultOf(provider: ScriptedProvider, call: number): string {
  return JSON.stringify(provider.calls.at(call)?.messages.at(-1));
}

function mirrorOf(fixture: SeedFixture): string {
  return join(
    fixture.root,
    "out",
    "state",
    "origin",
    `${fixture.bindingId}.git`,
  );
}

function logRecords(stderr: readonly string[]): Record<string, unknown>[] {
  return stderr
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function spawnTasksRun(
  args: string[],
  input: Buffer,
): Promise<{ code: number | null; stderr: string }> {
  const entry = new URL("../../main.ts", import.meta.url).href;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
      ],
      { env: hostEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdout.resume();
    setTimeout(() => child.stdin.end(input), SLOW_WRITER_MS);
    child.on("close", (code) =>
      resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
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
      const startedAt = Date.now();
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
          claim: { created_at: number; expired_at: number };
          plan: { pending: { task: { id: string } }[] };
          affectedTests: unknown[];
          until: string | null;
        };
        result: { route: { kind: string } };
      };
      const { claim } = context.input;
      assert.ok(Math.abs(claim.created_at - startedAt) < START_TOLERANCE_MS);
      assert.equal(claim.expired_at - claim.created_at, CLAIM_LENGTH_MS);
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
    "a standalone run starts no claim watch and makes no claim read",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const intervals = t.mock.method(globalThis, "setInterval");
      const fixture = await seedFixture(t);
      const provider = scriptedProvider([
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
      assert.deepEqual(
        intervals.mock.calls.filter(
          (call) => call.arguments[1] === CLAIM_WATCH_INTERVAL_MS,
        ),
        [],
      );
    },
  );

  test(
    "--tree leaves the source and the mirror unchanged against a push to origin, to the mirror path and from the mirror",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const source = simpleGit(fixture.source);
      const before = await source.raw(["show-ref"]);
      const provider = scriptedProvider([
        bash(
          'git push origin HEAD:refs/heads/agent-push; echo push_exit=$?; M=$(git remote get-url origin); git push "$M" HEAD:refs/heads/agent-push; echo mirror_exit=$?; git -C "$M" push; echo from_mirror_exit=$?',
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
      const mirror = simpleGit(mirrorOf(fixture));
      assert.equal(
        (await mirror.raw(["config", "core.bare"])).trim(),
        BARE_VALUE,
      );
      assert.equal(await mirror.raw(["show-ref"]), before);
      assert.equal(await mirror.raw(["remote"]), CLEAN_OUTPUT);
      const pushed = toolResultOf(provider, 1);
      assert.match(pushed, /push_exit=(?!0)[0-9]+/);
      assert.match(pushed, /mirror_exit=(?!0)[0-9]+/);
      assert.match(pushed, /from_mirror_exit=(?!0)[0-9]+/);
    },
  );

  test(
    "agent bash receives a --pass-env variable and the fixed git variables, and no other variable of the host process",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      process.env[UNPASSED_NAME] = UNPASSED_VALUE;
      t.after(() => delete process.env[UNPASSED_NAME]);
      const provider = scriptedProvider([
        bash(
          `echo "unpassed=$${UNPASSED_NAME}"; test -n "$${PASS_NAME}" && echo passed=yes; echo "home=$HOME"; echo "helper=$(git config --get credential.helper)"; echo "nosystem=$GIT_CONFIG_NOSYSTEM"; echo "ssh=$GIT_SSH_COMMAND"`,
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
      const shown = toolResultOf(provider, 1);
      assert.match(shown, /unpassed=\\n/);
      assert.match(shown, /passed=yes/);
      assert.match(shown, /home=[^\\]*\/out\/state\/home/);
      assert.match(shown, /helper=\\n/);
      assert.match(shown, /nosystem=1\\n/);
      assert.match(shown, /ssh=ssh -F \/dev\/null -o IdentitiesOnly=yes/);
    },
  );

  test(
    "the run removes the ambient cloud credentials of the shell before the model runtime opens",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const shellEnv: NodeJS.ProcessEnv = {
        ...hostEnvironment(),
        AWS_PROFILE: "ambient-profile",
        AWS_SECRET_ACCESS_KEY: "ambient-secret-0123456789",
        AZURE_OPENAI_BASE_URL: "https://ambient.invalid/openai",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://ambient.invalid/bedrock",
      };
      const seen: NodeJS.ProcessEnv[] = [];
      const scripted = scriptedModelRuntime(provider);
      const run = commandRun(fixture, provider, {
        shellEnv,
        modelRuntimeFactory: (input) => {
          seen.push({ ...shellEnv });
          return scripted(input);
        },
      });
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      assert.ok(seen.length > NO_CALLS);
      const home = join(fixture.root, "out", "state", "home");
      for (const env of seen) {
        assert.equal(env.AWS_PROFILE, undefined);
        assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
        assert.equal(env.AZURE_OPENAI_BASE_URL, undefined);
        assert.equal(env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, undefined);
        assert.equal(env.HOME, home);
        assert.ok(env.AWS_CONFIG_FILE?.startsWith(home));
        assert.ok(env.AWS_SHARED_CREDENTIALS_FILE?.startsWith(home));
      }
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
      writeFileSync(
        join(fixture.root, "system.md"),
        "Local system prompt marker.",
      );
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
        system_prompt: sha256Of("Local system prompt marker."),
        templates: { work: sha256Of("Local work template marker.") },
      });
    },
  );

  test(
    "--skip-release-gate ends with completed, no route and no release tree",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const output = join(fixture.root, "out");
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { skipReleaseGate: true, verify: true }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const context = readJson(output, "context.json") as {
        input: { until: string | null };
        result: { route: unknown };
      };
      assert.equal(context.input.until, RELEASE_GATE_LOOP);
      assert.equal(context.result.route, null);
      assert.ok(!existsSync(join(output, "state", "release")));
    },
  );

  test(
    "progress.json holds the last unit scope of each unit",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const run = commandRun(
        fixture,
        scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      );
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const [work] = (fixture.seed.revision as { tasks: { id: string }[] })
        .tasks;
      const progress = readJson(join(fixture.root, "out"), "progress.json") as {
        units: Record<
          string,
          { unit: { id: string }; passed: boolean; result: { kind: string } }
        >;
      };
      assert.deepEqual(Object.keys(progress.units), [work!.id]);
      const unit = progress.units[work!.id]!;
      assert.equal(unit.unit.id, work!.id);
      assert.equal(unit.passed, true);
      assert.equal(unit.result.kind, UNIT_COMPLETE);
    },
  );

  for (const { name, step, code, shape, arrange } of [
    {
      name: "an invalid affected declaration at the base, in the first branch of workspace.static",
      step: "affected.declaration",
      code: EnvironmentFailure.AffectedInvalid,
      shape: () => {},
      arrange: declareInvalidAffected,
    },
    {
      name: "a failed live setup, in the first branch of start.inputs",
      step: "env.setup(live)",
      code: EnvironmentFailure.SetupFailed,
      shape: (seed: Record<string, unknown>) => {
        (
          seed.setup as { repositories: { environment: unknown }[] }
        ).repositories[0]!.environment = FAILED_SETUP;
      },
      arrange: async () => {},
    },
  ])
    test(
      `the stop check passes for a stop of ${name}`,
      { timeout: TEST_TIMEOUT_MS },
      async (t) => {
        const fixture = await seedFixture(t, shape);
        await arrange(fixture);
        const run = commandRun(fixture, scriptedProvider([]));
        const exit = await tasksRun(
          fixture.seedFolder,
          runOptions(fixture, { verify: true }),
          run.io,
        );
        assert.equal(exit, TasksExit.Stopped, run.stderr.join(""));
        const result = readJson(join(fixture.root, "out"), "result.json") as {
          stop: { reason: string; code: string };
          step: string;
          checks: { check: number; applies: boolean; passed: boolean }[];
        };
        assert.deepEqual(
          { reason: result.stop.reason, code: result.stop.code },
          { reason: EndReason.EnvironmentFailed, code },
        );
        assert.equal(result.step, step);
        assert.deepEqual(
          result.checks.find(({ check }) => check === STOP_CODE_CHECK),
          { check: STOP_CODE_CHECK, applies: true, passed: true },
        );
      },
    );

  test(
    "metrics.json holds the run time of each step of tasks_prepare and of the tasks phase",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const run = commandRun(
        fixture,
        scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      );
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { skipReleaseGate: true }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const metrics = readJson(join(fixture.root, "out"), "metrics.json") as {
        steps: { step: string; ms: number }[];
      };
      const workspaceStatic = [
        "affected.declaration",
        "setup.entries(live)",
        "agent.open",
      ];
      const startInputs = ["units.plan", "env.setup(live)"];
      const steps = metrics.steps.map((entry) => entry.step);
      assert.deepEqual(
        steps.splice(0, workspaceStatic.length).sort(),
        workspaceStatic.sort(),
      );
      assert.deepEqual(steps.splice(0, 1), ["state.open"]);
      assert.deepEqual(
        steps.splice(0, startInputs.length).sort(),
        startInputs.sort(),
      );
      assert.deepEqual(steps, [
        "budget.check",
        "unit.enter",
        "unit.turn",
        "verify.own",
        "unit_record.put",
        "unit.leave",
      ]);
      assert.ok(metrics.steps.every((entry) => entry.ms >= NO_CALLS));
    },
  );

  test(
    "a seed with unit_records skips the unit with a valid record, and the outbox holds the put of the other unit",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const first = task("first", "true");
      const second = task("second", "grep -q good file");
      const fixture = await seedFixture(t, (seed) => {
        (seed.revision as { tasks: unknown[] }).tasks = [first, second];
      });
      const git = simpleGit(fixture.source);
      await git.raw(["checkout", "-q", "-b", "node"]);
      await git.raw([
        ...COMMIT_IDENTITY,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "first",
      ]);
      const firstCommit = (await git.revparse(["HEAD"])).trim();
      await git.raw(["checkout", "-q", "main"]);
      const setup = fixture.seed.setup as Record<string, unknown>;
      setup.unit_records = [
        {
          unit_id: first.id,
          content_digest: digest(first.content),
          commits: [{ binding_id: fixture.bindingId, commit: firstCommit }],
        },
      ];
      fixture.seed.heads = { [fixture.bindingId]: firstCommit };
      writeFileSync(
        join(fixture.seedFolder, "seed.json"),
        JSON.stringify(fixture.seed),
      );
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { skipReleaseGate: true }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const out = join(fixture.root, "out");
      assert.deepEqual(readJson(out, "progress.json").completed_units, [
        second.id,
      ]);
      const outbox = JSON.parse(
        readFileSync(join(out, "outbox.json"), "utf8"),
      ) as { operation: string; step: string; body: { unit_id: string } }[];
      assert.deepEqual(
        outbox.map(({ operation, step, body }) => ({
          operation,
          step,
          unit_id: body.unit_id,
        })),
        [
          {
            operation: "worker.execution.unit_record.put",
            step: "unit_record.put",
            unit_id: second.id,
          },
        ],
      );
    },
  );

  test(
    "each outbox entry names the step of its write",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const run = commandRun(
        fixture,
        scriptedProvider([
          writeGood(),
          fauxAssistantMessage(
            fauxToolCall(HostTool.EvidenceUpload, { path: "file" }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("done"),
        ]),
      );
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { skipReleaseGate: true }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const outbox = JSON.parse(
        readFileSync(join(fixture.root, "out", "outbox.json"), "utf8"),
      ) as { step: string | null }[];
      assert.deepEqual(
        outbox.map((entry) => entry.step),
        ["unit.turn", "unit_record.put"],
      );
    },
  );

  test(
    "a seeded plan with --unit runs only the named unit",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const first = task("first", "grep -q good file");
      const second = task("second", "true");
      const fixture = await seedFixture(t, (seed) => {
        (seed.revision as { tasks: unknown[] }).tasks = [first, second];
        seed.plan = {
          pending: [
            { unit_id: first.id, instruction: null },
            { unit_id: second.id, instruction: null },
          ],
          node: null,
        };
      });
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { unit: [first.id], skipReleaseGate: true }),
        run.io,
      );
      assert.equal(code, TasksExit.Success, run.stderr.join(""));
      const progress = readJson(join(fixture.root, "out"), "progress.json");
      assert.deepEqual(progress.completed_units, [first.id]);
      const unknown = commandRun(fixture, scriptedProvider([]));
      assert.equal(
        (
          await diagnosticOf(
            tasksRun(
              fixture.seedFolder,
              runOptions(fixture, { unit: ["task_unknown"], force: true }),
              unknown.io,
            ),
          )
        ).code,
        TasksErrorCode.UnitUnknown,
      );
    },
  );

  test(
    "a failed --verify check exits with 4",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t, (seed) => {
        const revision = seed.revision as {
          content: { verifications: string[] };
        };
        revision.content.verifications = [
          "touch ../../checkouts/repo/leftover",
        ];
      });
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { verify: true }),
        run.io,
      );
      assert.equal(code, TasksExit.VerifyFailed, run.stderr.join(""));
      const result = readJson(join(fixture.root, "out"), "result.json") as {
        exit_code: number;
        checks: { check: number; passed: boolean }[];
      };
      assert.equal(result.exit_code, TasksExit.VerifyFailed);
      assert.deepEqual(
        result.checks
          .filter((check) => !check.passed)
          .map(({ check }) => check),
        [CLEAN_TREES_CHECK],
      );
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
    "an unknown error in the tasks phase ends with failed, exit 5, a log record with its reason and internal_error",
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
        if (text.includes('"task started"'))
          throw new Error("unknown failure marker");
        stderr(text);
      };
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.InternalError);
      assert.equal(JSON.parse(run.stdout.join("")).end, RunEndKind.Failed);
      const result = readJson(join(fixture.root, "out"), "result.json");
      assert.equal(result.end, RunEndKind.Failed);
      assert.equal(result.exit_code, TasksExit.InternalError);
      const failed = logRecords(run.stderr).find(
        (record) => record.msg === TASKS_FAILED,
      );
      assert.match(String(failed?.reason), /unknown failure marker/);
      assert.match(
        run.stderr.join(""),
        new RegExp(TasksErrorCode.InternalError),
      );
    },
  );

  test(
    "an error after the tasks end writes result.json with failed and exit 5",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const provider = scriptedProvider([
        writeGood(),
        bash("mkdir ../../../context.json"),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.InternalError);
      const result = readJson(join(fixture.root, "out"), "result.json");
      assert.equal(result.end, RunEndKind.Failed);
      assert.equal(result.exit_code, TasksExit.InternalError);
    },
  );

  test(
    "a pi directory bound to another directory ends the run with exit 5, internal_error, a tasks failed record and result.json",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const run = commandRun(fixture, scriptedProvider([]), {
        piDirectory: null,
      });
      const code = await tasksRun(
        fixture.seedFolder,
        runOptions(fixture),
        run.io,
      );
      assert.equal(code, TasksExit.InternalError);
      assert.match(
        run.stderr.join(""),
        new RegExp(TasksErrorCode.InternalError),
      );
      const result = readJson(join(fixture.root, "out"), "result.json");
      assert.equal(result.end, RunEndKind.Failed);
      assert.equal(result.exit_code, TasksExit.InternalError);
      assert.ok(
        logRecords(run.stderr).some((record) => record.msg === TASKS_FAILED),
      );
    },
  );

  test(
    "a diagnostic after the output folder exists writes result.json, so --force runs the next command",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const wrong = runOptions(fixture, { unit: ["task_unknown"] });
      for (const options of [wrong, { ...wrong, force: true }]) {
        const run = commandRun(fixture, scriptedProvider([]));
        assert.equal(
          (await diagnosticOf(tasksRun(fixture.seedFolder, options, run.io)))
            .code,
          TasksErrorCode.UnitUnknown,
        );
        const result = readJson(join(fixture.root, "out"), "result.json");
        assert.equal(result.end, DIAGNOSTIC_END);
        assert.equal(result.code, TasksErrorCode.UnitUnknown);
        assert.equal(result.exit_code, ExitCode.Failure);
      }
      const provider = scriptedProvider([
        writeGood(),
        fauxAssistantMessage("done"),
      ]);
      const run = commandRun(fixture, provider);
      assert.equal(
        await tasksRun(
          fixture.seedFolder,
          runOptions(fixture, { force: true }),
          run.io,
        ),
        TasksExit.Success,
        run.stderr.join(""),
      );
    },
  );

  test("--force refuses a folder with state/ and no result.json, and keeps its content", async (t) => {
    const fixture = await seedFixture(t);
    const output = join(fixture.root, "out");
    mkdirSync(join(output, "state"), { recursive: true });
    writeFileSync(join(output, "state", "kept.txt"), KEPT_TEXT);
    const run = commandRun(fixture, scriptedProvider([]));
    const refusal = await diagnosticOf(
      tasksRun(
        fixture.seedFolder,
        runOptions(fixture, { force: true }),
        run.io,
      ),
    );
    assert.equal(refusal.code, TasksErrorCode.OutputExists);
    assert.equal(
      readFileSync(join(output, "state", "kept.txt"), "utf8"),
      KEPT_TEXT,
    );
  });
});

suite("worker tasks run credentials", () => {
  test("live mode without --credential-stdin and a credential option exit with 1 before any read", async (t) => {
    const fixture = await seedFixture(t);
    const output = join(fixture.root, "out");
    const env = { ...hostEnvironment(), XDG_CONFIG_HOME: temporary(t) };
    const live = await runInProcess(
      ["worker", "tasks", "run", fixture.seedFolder, "--output", output],
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
        "--output",
        output,
        "--credential",
        CREDENTIAL_CANARY,
      ],
      env,
    );
    assert.notEqual(option.code, ExitCode.Success);
    assert.ok(!option.stdout.includes(CREDENTIAL_CANARY));
    assert.ok(!existsSync(output));
  });

  test("a slow standard input writer gives the credential to the command", async (t) => {
    const fixture = await seedFixture(t);
    const result = await spawnTasksRun(
      [
        "worker",
        "tasks",
        "run",
        fixture.seedFolder,
        "--credential-stdin",
        "--tree",
        `${fixture.bindingId}=${fixture.source}`,
        "--output",
        join(fixture.root, "out"),
      ],
      Buffer.from(
        JSON.stringify({
          provider_id: "openai",
          credential: { type: "api_key", key: CREDENTIAL_CANARY },
        }),
      ),
    );
    assert.equal(result.code, ExitCode.Failure);
    assert.match(result.stderr, new RegExp(TasksErrorCode.CredentialInvalid));
    assert.match(result.stderr, /provider_id/);
    assert.ok(!result.stderr.includes(CREDENTIAL_CANARY));
  });

  test("a terminal, a malformed object, another provider and an expiring token are refused before the output folder exists", async (t) => {
    const fixture = await seedFixture(t);
    const output = join(fixture.root, "out");
    const stdinOf = (value: unknown) => () =>
      Buffer.from(JSON.stringify(value));
    const refusals: [Partial<TasksCommandIo>, string, string][] = [
      [{ stdinTerminal: true }, TasksErrorCode.CredentialInvalid, "stdin"],
      [
        { readStdin: () => Buffer.from("{not json") },
        TasksErrorCode.CredentialInvalid,
        "credential",
      ],
      [
        {
          readStdin: stdinOf({
            provider_id: "openai",
            credential: { type: "api_key", key: CREDENTIAL_CANARY },
          }),
        },
        TasksErrorCode.CredentialInvalid,
        "provider_id",
      ],
      [
        {
          readStdin: stdinOf({
            provider_id: "anthropic",
            credential: {
              type: "oauth",
              access: CREDENTIAL_CANARY,
              refresh: CREDENTIAL_CANARY,
              expires: Date.now() + 60000,
            },
          }),
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

  test("the routing metadata comes from standard input, and a seed endpoint that differs is refused before the output folder exists", async (t) => {
    const attacked = await seedFixture(t, (seed) => {
      const setup = seed.setup as { agents: { metadata: unknown }[] };
      setup.agents[0]!.metadata = { base_url: ATTACKER_URL };
    });
    const compatible = await seedFixture(t, (seed) => {
      const setup = seed.setup as {
        agents: {
          metadata: unknown;
          effective_configuration: { provider: string };
        }[];
      };
      setup.agents[0]!.effective_configuration.provider = "openai-compatible";
      setup.agents[0]!.metadata = {
        base_url: "https://models.example.invalid/v1",
        models: [{ id: "claude-sonnet-4-5" }],
      };
    });
    const cases: [SeedFixture, Buffer][] = [
      [attacked, apiKeyInput()],
      [
        compatible,
        Buffer.from(
          JSON.stringify({
            provider_id: "openai-compatible",
            credential: { type: "api_key", key: CREDENTIAL_CANARY },
          }),
        ),
      ],
      [
        compatible,
        Buffer.from(
          JSON.stringify({
            provider_id: "openai-compatible",
            credential: { type: "api_key", key: CREDENTIAL_CANARY },
            metadata: {
              base_url: ATTACKER_URL,
              models: [{ id: "claude-sonnet-4-5" }],
            },
          }),
        ),
      ],
    ];
    for (const [fixture, input] of cases) {
      const run = commandRun(fixture, scriptedProvider([]), {
        readStdin: () => input,
      });
      const refusal = await diagnosticOf(
        tasksRun(fixture.seedFolder, runOptions(fixture), run.io),
      );
      assert.equal(refusal.code, TasksErrorCode.CredentialInvalid);
      assert.deepEqual(refusal.fields, [["field", "metadata"]]);
      assert.ok(!existsSync(join(fixture.root, "out")));
    }
  });

  test("the standard input buffer is zero after the parse", async (t) => {
    const fixture = await seedFixture(t);
    const input = apiKeyInput();
    const run = commandRun(fixture, scriptedProvider([]), {
      readStdin: () => input,
      modelRuntimeFactory: async () => {
        throw new Error("stop after the parse");
      },
    });
    await tasksRun(fixture.seedFolder, runOptions(fixture), run.io);
    assert.ok(input.every((byte) => byte === ZERO_BYTE));
  });

  test("--pass-env refuses a credential variable of a provider", async (t) => {
    const fixture = await seedFixture(t);
    const run = commandRun(fixture, scriptedProvider([]), {
      shellEnv: {
        ...hostEnvironment(),
        ANTHROPIC_API_KEY: CREDENTIAL_CANARY,
      },
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

  test("--pass-env refuses each ambient cloud credential variable", async (t) => {
    const fixture = await seedFixture(t);
    for (const name of [
      "AWS_PROFILE",
      "AWS_SECRET_ACCESS_KEY",
      "AZURE_OPENAI_BASE_URL",
    ]) {
      const run = commandRun(fixture, scriptedProvider([]), {
        shellEnv: { ...hostEnvironment(), [name]: CREDENTIAL_CANARY },
      });
      const refusal = await diagnosticOf(
        tasksRun(
          fixture.seedFolder,
          runOptions(fixture, { passEnv: [name] }),
          run.io,
        ),
      );
      assert.equal(refusal.code, TasksErrorCode.OptionInvalid, name);
    }
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
