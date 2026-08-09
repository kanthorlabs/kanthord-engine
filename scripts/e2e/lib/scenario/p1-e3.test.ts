import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPrerequisites, runP1E3, p1e3, type RealInputs } from "./p1-e3.ts";
import { main } from "../main.ts";
import { RunnerError } from "../errors.ts";
import { E2eEnvError, type E2eEnv } from "../../env.ts";
import { createLedger } from "../resources.ts";
import type { ScenarioContext } from "./context.ts";
import type { CommandRecord } from "../command.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
} from "../driver/index.ts";
import type { SshTarget } from "../driver/ssh.ts";
import { searchOrder } from "../../../../src/services/config/search-order.ts";

function record(
  argv: readonly string[],
  input: Partial<CommandRecord> = {},
): CommandRecord {
  return {
    argv,
    cwd: input.cwd ?? process.cwd(),
    exitCode: input.exitCode ?? 0,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  };
}

function fakeContext(
  overrides: Partial<ScenarioContext> = {},
): ScenarioContext & {
  assertionNames(): readonly string[];
  releaseAll(): ReturnType<ReturnType<typeof createLedger>["releaseAll"]>;
} {
  const ledger = createLedger();
  const assertionNames: string[] = [];
  return {
    tag: "p1e3-test",
    scenarioId: "P1-E3",
    bundleDirectory: "/tmp/p1e3-test-bundle",
    take: ledger.take,
    sink: { print(): void {}, record(): void {} },
    assert(name: string, expected: unknown, actual: unknown): void {
      let passed = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }
      assertionNames.push(name);
      if (!passed) {
        throw new RunnerError("assertion-failed", name);
      }
    },
    daemonHost: null,
    clientHost: null,
    assertionNames(): readonly string[] {
      return assertionNames;
    },
    releaseAll(): ReturnType<ReturnType<typeof createLedger>["releaseAll"]> {
      return ledger.releaseAll();
    },
    ...overrides,
  };
}

function stubLoadEnv(overrides: Partial<E2eEnv> = {}): () => E2eEnv {
  return () => ({
    ghToken: "gh-secret",
    ghRepo: "kanthorlabs/kanthord",
    ghBaseBranch: "main",
    runId: "r1",
    ...overrides,
  });
}

function baseEnv(workDir: string): Record<string, string | undefined> {
  return {
    KANTHORD_E2E_REAL_PLAN: join(workDir, "plan"),
    KANTHORD_E2E_REAL_OBJECTIVES: "2",
    KANTHORD_E2E_REAL_TASKS: "4",
  };
}

function reachableExecute(
  unreachableHost?: string,
): (target: SshTarget, argv: readonly string[]) => Promise<CommandRecord> {
  return async (target, argv) => {
    if (unreachableHost !== undefined && target.host === unreachableHost) {
      return record(argv, { exitCode: 255, stderr: "ssh: connect refused" });
    }
    return record(argv, {});
  };
}

test("checkPrerequisites drives each of the seven rows one at a time, rejecting unavailable with the exact message", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e3-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const rows: ReadonlyArray<
    readonly [
      name: string,
      buildContext: () => ScenarioContext,
      buildEnv: () => Record<string, string | undefined>,
      buildExecute: () => (
        target: SshTarget,
        argv: readonly string[],
      ) => Promise<CommandRecord>,
      message: string,
    ]
  > = [
    [
      "context.daemonHost is null",
      () => fakeContext({ daemonHost: null, clientHost: "client.example" }),
      () => baseEnv(workDir),
      () => reachableExecute(),
      "P1-E3 needs --daemon-host",
    ],
    [
      "context.clientHost is null",
      () => fakeContext({ daemonHost: "daemon.example", clientHost: null }),
      () => baseEnv(workDir),
      () => reachableExecute(),
      "P1-E3 needs --client-host",
    ],
    [
      "KANTHORD_E2E_REAL_PLAN is absent",
      () =>
        fakeContext({
          daemonHost: "daemon.example",
          clientHost: "client.example",
        }),
      () => ({ ...baseEnv(workDir), KANTHORD_E2E_REAL_PLAN: undefined }),
      () => reachableExecute(),
      "P1-E3 needs KANTHORD_E2E_REAL_PLAN",
    ],
    [
      "KANTHORD_E2E_REAL_OBJECTIVES is absent",
      () =>
        fakeContext({
          daemonHost: "daemon.example",
          clientHost: "client.example",
        }),
      () => ({ ...baseEnv(workDir), KANTHORD_E2E_REAL_OBJECTIVES: undefined }),
      () => reachableExecute(),
      "P1-E3 needs KANTHORD_E2E_REAL_OBJECTIVES",
    ],
    [
      "KANTHORD_E2E_REAL_TASKS is absent",
      () =>
        fakeContext({
          daemonHost: "daemon.example",
          clientHost: "client.example",
        }),
      () => ({ ...baseEnv(workDir), KANTHORD_E2E_REAL_TASKS: undefined }),
      () => reachableExecute(),
      "P1-E3 needs KANTHORD_E2E_REAL_TASKS",
    ],
    [
      "the daemon host is unreachable",
      () =>
        fakeContext({
          daemonHost: "daemon.example",
          clientHost: "client.example",
        }),
      () => baseEnv(workDir),
      () => reachableExecute("daemon.example"),
      "P1-E3 cannot reach the daemon host daemon.example",
    ],
    [
      "the client host is unreachable",
      () =>
        fakeContext({
          daemonHost: "daemon.example",
          clientHost: "client.example",
        }),
      () => baseEnv(workDir),
      () => reachableExecute("client.example"),
      "P1-E3 cannot reach the client host client.example",
    ],
  ];

  for (const [name, buildContext, buildEnv, buildExecute, message] of rows) {
    await t.test(name, async () => {
      await assert.rejects(
        checkPrerequisites(
          buildContext(),
          buildExecute(),
          buildEnv(),
          stubLoadEnv(),
        ),
        (error: unknown) => {
          assert.ok(error instanceof RunnerError);
          assert.equal(error.code, "unavailable");
          assert.equal(error.message, message);
          return true;
        },
      );
    });
  }
});

test("KANTHORD_E2E_REAL_OBJECTIVES=0 and a non-numeric value each reject as unavailable", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e3-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  for (const value of ["0", "not-a-number"]) {
    await t.test(`KANTHORD_E2E_REAL_OBJECTIVES=${value}`, async () => {
      const context = fakeContext({
        daemonHost: "daemon.example",
        clientHost: "client.example",
      });
      const env = { ...baseEnv(workDir), KANTHORD_E2E_REAL_OBJECTIVES: value };

      await assert.rejects(
        checkPrerequisites(context, reachableExecute(), env, stubLoadEnv()),
        (error: unknown) => {
          assert.ok(error instanceof RunnerError);
          assert.equal(error.code, "unavailable");
          return true;
        },
      );
    });
  }
});

test("checkPrerequisites resolves the RealInputs derived from .env.e2e and the three required env vars", async () => {
  const context = fakeContext({
    daemonHost: "daemon.example",
    clientHost: "client.example",
  });
  const env = {
    KANTHORD_E2E_REAL_PLAN: "/tmp/plan",
    KANTHORD_E2E_REAL_OBJECTIVES: "2",
    KANTHORD_E2E_REAL_TASKS: "4",
  };

  const result = await checkPrerequisites(
    context,
    reachableExecute(),
    env,
    stubLoadEnv(),
  );

  assert.deepEqual(result, {
    origin: "https://github.com/kanthorlabs/kanthord.git",
    defaultBranch: "main",
    token: "gh-secret",
    planPath: "/tmp/plan",
    expectedObjectiveCount: 2,
    expectedTaskCount: 4,
  });
});

test("a loadEnv rejection is wrapped as unavailable naming each missing key", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e3-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  try {
    const context = fakeContext({
      daemonHost: "daemon.example",
      clientHost: "client.example",
    });
    const env = baseEnv(workDir);
    const loadEnv = (): E2eEnv => {
      throw new E2eEnvError("boom", ["E2E_GH_TOKEN", "E2E_GH_REPO"]);
    };

    await assert.rejects(
      checkPrerequisites(context, reachableExecute(), env, loadEnv),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "unavailable");
        assert.equal(
          error.message,
          "P1-E3 needs E2E_GH_TOKEN, E2E_GH_REPO in .env.e2e",
        );
        return true;
      },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a loadEnv rejection naming all three required keys preserves E2E_REQUIRED_KEYS order", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e3-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  try {
    const context = fakeContext({
      daemonHost: "daemon.example",
      clientHost: "client.example",
    });
    const env = baseEnv(workDir);
    const loadEnv = (): E2eEnv => {
      throw new E2eEnvError("boom", [
        "E2E_GH_TOKEN",
        "E2E_GH_REPO",
        "E2E_GH_BASE_BRANCH",
      ]);
    };

    await assert.rejects(
      checkPrerequisites(context, reachableExecute(), env, loadEnv),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "unavailable");
        assert.equal(
          error.message,
          "P1-E3 needs E2E_GH_TOKEN, E2E_GH_REPO, E2E_GH_BASE_BRANCH in .env.e2e",
        );
        return true;
      },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("KANTHORD_E2E_REAL_ORIGIN, KANTHORD_E2E_REAL_BRANCH and KANTHORD_E2E_REAL_TOKEN_FILE absent from env does not reject", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e3-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  try {
    const context = fakeContext({
      daemonHost: "daemon.example",
      clientHost: "client.example",
    });
    const env = baseEnv(workDir);
    assert.equal("KANTHORD_E2E_REAL_ORIGIN" in env, false);
    assert.equal("KANTHORD_E2E_REAL_BRANCH" in env, false);
    assert.equal("KANTHORD_E2E_REAL_TOKEN_FILE" in env, false);

    const result = await checkPrerequisites(
      context,
      reachableExecute(),
      env,
      stubLoadEnv(),
    );

    assert.equal(result.planPath, env.KANTHORD_E2E_REAL_PLAN);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function fakeDriver(
  planDirectory: string,
  cliDispatch: (
    argv: readonly string[],
  ) => CommandRecord | Promise<CommandRecord>,
  deliverDirectoryCalls: Array<readonly [HostRole, string, string]>,
  deliverTokenCalls: string[] = [],
): ExecutionDriver {
  return {
    name: "ssh",
    async identity() {
      return { hostname: "p1e3-test", platform: "linux", architecture: "x64" };
    },
    async deliverBinary() {
      return "~/.kanthord-e2e-p1e3-test/bin/kanthord";
    },
    async deliverDirectory(role: HostRole, source: string, name: string) {
      deliverDirectoryCalls.push([role, source, name]);
      return planDirectory;
    },
    async retrieveDirectory(
      _role: HostRole,
      source: string,
      destination: string,
    ) {
      await cp(source, destination, { recursive: true });
    },
    async deliverConfig() {
      return "~/.kanthord-e2e-p1e3-test/config.json";
    },
    async deliverToken(token: string) {
      deliverTokenCalls.push(token);
      return "~/.kanthord-e2e-p1e3-test/token";
    },
    async probeOrigin() {
      throw new Error("not used by this test");
    },
    async assertBareMachine() {
      return;
    },
    async cli(argv: readonly string[]): Promise<CommandRecord> {
      return cliDispatch(argv);
    },
    issue: async (request) => {
      if (request.method === "GET" && request.path === "/v1/status") {
        return {
          status: 200,
          body: JSON.stringify({ version: "27.8.1" }),
        };
      }
      if (request.path.endsWith("/plan/validate")) {
        return {
          status: 200,
          body: JSON.stringify({
            choices: [{ id: "task_a", suggested: "database" }],
          }),
        };
      }
      const body: Readonly<{ fromRevision: string | null }> =
        request.body === undefined
          ? { fromRevision: null }
          : (JSON.parse(request.body) as Readonly<{
              fromRevision: string | null;
            }>);
      if (body.fromRevision === "rev_1") {
        return {
          status: 409,
          body: JSON.stringify({
            code: "stale-revision",
            message: "the import names a stale revision",
            details: { expected: body.fromRevision, current: "rev_2" },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({ revision: "rev_3", documents: [], absent: [] }),
      };
    },
    async startDaemon(config: DaemonConfig): Promise<DaemonHandle> {
      return {
        baseUrl: `http://${config.http.bind}:${String(config.http.port)}`,
        allowedHost: config.http.allowedHosts[0] ?? "",
        async ready() {},
        async stop() {},
        async logs() {
          return { stdout: "kanthord: ready\n", stderr: "" };
        },
      };
    },
    async startDaemonExpectingRefusal(
      config: DaemonConfig | null,
    ): Promise<CommandRecord> {
      const home = config?.home ?? "~/.kanthord-e2e-p1e3-test";
      const candidates = searchOrder({
        env: {},
        cwd: home,
        homeDir: home,
        etcDir: "/etc",
      });
      return record(["kanthord", "serve"], {
        cwd: home,
        exitCode: 1,
        stderr: `kanthord: config-not-found: no config file found; searched: ${candidates.join(", ")}\n`,
      });
    },
    async collectLogs() {
      return {};
    },
  };
}

function buildJourneyDispatch(
  planDirectory: string,
): (argv: readonly string[]) => CommandRecord | Promise<CommandRecord> {
  let planImportCalls = 0;
  const findFlag = (
    argv: readonly string[],
    flag: string,
  ): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  return (argv) => {
    if (argv[0] === "--version") {
      return record(argv, { stdout: "27.8.1\n" });
    }
    if (argv[0] === "credential") {
      return record(argv, { stdout: "kanthord: registered real cred_1\n" });
    }
    if (argv[0] === "repository" && argv[1] === "register") {
      const upstream = findFlag(argv, "--upstream") ?? "trunk";
      return record(argv, {
        stdout: `kanthord: registered real repo_1\nkanthord: upstream ${upstream}\n`,
      });
    }
    if (argv[0] === "repository" && argv[1] === "show") {
      return record(argv, {
        stdout:
          "kanthord: landing refs/heads/trunk oid_a\nkanthord: tracking refs/remotes/origin/trunk oid_a\n",
      });
    }
    if (argv[0] === "project" && argv[1] === "create") {
      return record(argv, {
        stdout: "kanthord: project proj_1\nkanthord: name journey\n",
      });
    }
    if (argv[0] === "project" && argv[1] === "repository") {
      return record(argv, {});
    }
    if (argv[0] === "plan" && argv[1] === "import") {
      planImportCalls += 1;
      if (planImportCalls === 1) {
        return record(argv, { stdout: "kanthord: revision rev_1\n" });
      }
      return record(argv, {
        stdout: "kanthord: revision rev_2\nkanthord: task_a -> database\n",
      });
    }
    if (argv[0] === "plan" && argv[1] === "export") {
      const directory = findFlag(argv, "--directory") as string;
      // mirror the real CLI's root/plan convention (src/cli/plan/directory.ts),
      // so this fake's export write matches the "plan/objective.md" shape that
      // cp(planRoot, ...) produces for the accepted-tree snapshot.
      mkdirSync(join(directory, "plan"), { recursive: true });
      writeFileSync(
        join(directory, "plan", "objective.md"),
        "a real objective\n",
      );
      return record(argv, {});
    }
    if (argv[0] === "status") {
      return record(argv, {
        stdout:
          "kanthord: node objective ready - 2\nkanthord: node task pending - 4\n",
      });
    }
    if (argv[0] === "run") {
      return record(argv, {
        exitCode: 220,
        stderr: "kanthord: not-implemented: run is not implemented\n",
      });
    }
    throw new Error(
      `unexpected cli invocation in the p1-e3 fake: ${argv.join(" ")}`,
    );
  };
}

async function withRealPlan<T>(
  body: (workDir: string) => Promise<T>,
): Promise<T> {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e3-run-"));
  try {
    mkdirSync(join(workDir, "plan"), { recursive: true });
    writeFileSync(join(workDir, "plan", "objective.md"), "a real objective\n");
    return await body(workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const seventeenJourneyNames = [
  "no-config-exit",
  "no-config-names-search-order",
  "first-location-starts",
  "version-parity",
  "credential-registered",
  "repository-registered",
  "ref-layout",
  "project-created",
  "repository-bound",
  "plan-imported",
  "export-byte-identical",
  "reimport-same-revision",
  "reimport-choices-suggested",
  "reimport-stale-revision",
  "status-counts",
  "run-not-implemented",
  "status-unchanged",
];

test("with a driver and every prerequisite present, runP1E3 calls runJourney exactly once, in the seventeen named order, against a profile with fixtureRoot null and expectedObjectIds null", async (t) => {
  await withRealPlan(async (workDir) => {
    // "delivered" is its own namespace, nested one level below workDir, so its
    // "plan" child never collides with workDir's own pre-seeded "plan"
    // (the real source withRealPlan seeds), once journey.ts's planRoot walks up
    // from profile.planDirectory to its parent.
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    const deliverDirectoryCalls: Array<readonly [HostRole, string, string]> =
      [];
    const driver = fakeDriver(
      planDeliveryDirectory,
      buildJourneyDispatch(planDeliveryDirectory),
      deliverDirectoryCalls,
    );
    // seed the delivered directory as deliverDirectory would on a real host
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const context = fakeContext({
      daemonHost: "daemon.example",
      clientHost: "client.example",
    });
    t.after(() => context.releaseAll());
    const env = baseEnv(workDir);
    const inputs = await checkPrerequisites(
      context,
      reachableExecute(),
      env,
      stubLoadEnv(),
    );

    await runP1E3(context, driver, inputs);

    assert.deepEqual(context.assertionNames(), seventeenJourneyNames);
    assert.deepEqual(deliverDirectoryCalls, [
      ["client", inputs.planPath, "plan"],
    ]);
  });
});

test("runP1E3 calls deliverToken exactly once with the token, and passes origin, defaultBranch, localPlanPath, expectedObjectiveCount and expectedTaskCount straight through to createRealProfile", async (t) => {
  await withRealPlan(async (workDir) => {
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const deliverDirectoryCalls: Array<readonly [HostRole, string, string]> =
      [];
    const deliverTokenCalls: string[] = [];
    const repositoryRegisterCalls: string[][] = [];
    const dispatch = buildJourneyDispatch(planDeliveryDirectory);
    const driver = fakeDriver(
      planDeliveryDirectory,
      (argv) => {
        if (argv[0] === "repository" && argv[1] === "register") {
          repositoryRegisterCalls.push([...argv]);
        }
        return dispatch(argv);
      },
      deliverDirectoryCalls,
      deliverTokenCalls,
    );

    const context = fakeContext({
      daemonHost: "daemon.example",
      clientHost: "client.example",
    });
    t.after(() => context.releaseAll());

    const inputs: RealInputs = {
      origin: "https://github.com/kanthorlabs/kanthord.git",
      defaultBranch: "main",
      token: "gh-secret",
      planPath: join(workDir, "plan"),
      expectedObjectiveCount: 2,
      expectedTaskCount: 4,
    };

    await runP1E3(context, driver, inputs);

    assert.deepEqual(deliverTokenCalls, ["gh-secret"]);
    assert.equal(repositoryRegisterCalls.length, 1);
    assert.ok(repositoryRegisterCalls[0]?.includes(inputs.origin));
    assert.ok(repositoryRegisterCalls[0]?.includes(inputs.defaultBranch));
    assert.deepEqual(deliverDirectoryCalls, [
      ["client", inputs.planPath, "plan"],
    ]);
  });
});

test("SECURITY: the token loaded from .env.e2e appears in no recorded command argv, no bundle assertion and no attached log", async (t) => {
  await withRealPlan(async (workDir) => {
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const deliverDirectoryCalls: Array<readonly [HostRole, string, string]> =
      [];
    const deliverTokenCalls: string[] = [];
    const commands: CommandRecord[] = [];
    const attachedLogs: string[] = [];

    const context = fakeContext({
      daemonHost: "daemon.example",
      clientHost: "client.example",
      sink: {
        print(): void {},
        record(entry: CommandRecord): void {
          commands.push(entry);
        },
      },
      attachLog(_name: string, text: string): void {
        attachedLogs.push(text);
      },
    });
    t.after(() => context.releaseAll());

    const dispatch = buildJourneyDispatch(planDeliveryDirectory);
    const driver = fakeDriver(
      planDeliveryDirectory,
      (argv) => {
        const result = dispatch(argv);
        context.sink.record(result as CommandRecord);
        return result;
      },
      deliverDirectoryCalls,
      deliverTokenCalls,
    );

    const token = "gh-secret-value-should-never-leak";
    const inputs: RealInputs = {
      origin: "https://github.com/kanthorlabs/kanthord.git",
      defaultBranch: "trunk",
      token,
      planPath: join(workDir, "plan"),
      expectedObjectiveCount: 2,
      expectedTaskCount: 4,
    };

    await runP1E3(context, driver, inputs);

    const logs = await driver.collectLogs();
    const commandsText = commands
      .map((entry) => entry.argv.join(" "))
      .join("\n");
    const assertionsText = context.assertionNames().join("\n");
    const logsText = [...attachedLogs, ...Object.values(logs)].join("\n");

    assert.equal(commandsText.includes(token), false);
    assert.equal(assertionsText.includes(token), false);
    assert.equal(logsText.includes(token), false);
    assert.deepEqual(deliverTokenCalls, [token]);
  });
});

test("scripts/e2e/lib contains no NEEDS-HUMAN marker anywhere", () => {
  const directory = fileURLToPath(new URL("../", import.meta.url));
  const selfPath = fileURLToPath(import.meta.url);
  const marker = ["NEEDS", "HUMAN"].join("-");

  function walk(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walk(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  for (const file of walk(directory)) {
    if (file === selfPath) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes(marker), false, `${file} contains ${marker}`);
  }
});

test("main(['P1-E1', '--daemon-host', 'a']) returns 2 with the message --daemon-host applies to P1-E3 only", async () => {
  const code = await main(["P1-E1", "--daemon-host", "a"]);
  assert.equal(code, 2);
});

test("main writes exactly that refusal message for a non-P1-E3 --daemon-host use", async (t) => {
  let captured = "";
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  });

  await main(["P1-E1", "--daemon-host", "a"]);

  assert.equal(
    captured,
    "e2e: invalid-argument: --daemon-host applies to P1-E3 only\n",
  );
});

test("on a prerequisite failure, main resolves exit code 3 and writes a bundle with outcome unavailable, an empty assertions array and no passed key", async (t) => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e3-main-"));
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await main(["P1-E3", "--tag", "t1"]);
  assert.equal(code, 3);

  const bundleText = await readFile(
    ".data/acceptance-t1/P1-E3/bundle.json",
    "utf8",
  );
  const bundle = JSON.parse(bundleText) as Readonly<{
    outcome: string;
    assertions: readonly unknown[];
    passed?: unknown;
  }>;
  assert.equal(bundle.outcome, "unavailable");
  assert.deepEqual(bundle.assertions, []);
  assert.equal(Object.hasOwn(bundle, "passed"), false);
});

test("p1e3 declares P1-E3, mode deployment, driver ssh, profile real", () => {
  assert.equal(p1e3.id, "P1-E3");
  assert.equal(p1e3.mode, "deployment");
  assert.equal(p1e3.driver, "ssh");
  assert.equal(p1e3.profile, "real");
});
