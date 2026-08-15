import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPrerequisites, runP1E5, p1e5, type RealInputs } from "./p1-e5.ts";

import { createBundleWriter, serializeBundle } from "../bundle.ts";
import { main } from "../main.ts";
import { RunnerError } from "../errors.ts";
import { E2eEnvError, type E2eEnv } from "../../env.ts";
import { createLedger } from "../resources.ts";
import type { ScenarioContext } from "./context.ts";
import type { CommandRecord } from "../command.ts";
import type { ReadRemoteRefs, RemoteRefsInput } from "../remote-refs.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
} from "../driver/index.ts";
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
  assertionRecords(): readonly Readonly<{
    name: string;
    expected: unknown;
    actual: unknown;
  }>[];
  releaseAll(): ReturnType<ReturnType<typeof createLedger>["releaseAll"]>;
} {
  const ledger = createLedger();
  const assertionNames: string[] = [];
  const assertionRecords: Array<
    Readonly<{
      name: string;
      expected: unknown;
      actual: unknown;
    }>
  > = [];
  return {
    tag: "p1e5-test",
    scenarioId: "P1-E5",
    bundleDirectory: "/tmp/p1e5-test-bundle",
    take: ledger.take,
    sink: { print(): void {}, record(): void {} },
    assert(name: string, expected: unknown, actual: unknown): void {
      assertionRecords.push({ name, expected, actual });
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
    assertionRecords(): readonly Readonly<{
      name: string;
      expected: unknown;
      actual: unknown;
    }>[] {
      return [...assertionRecords];
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
    KANTHORD_E2E_REAL_PENDING_TASKS: "2",
    KANTHORD_E2E_REAL_READY_TASKS: "2",
  };
}

const stableRemoteRefs: ReadRemoteRefs = async () => ({
  "refs/heads/main": "a".repeat(40),
});

test("checkPrerequisites drives each of the three required rows one at a time, rejecting unavailable with the exact message", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const rows: ReadonlyArray<
    readonly [
      name: string,
      buildContext: () => ScenarioContext,
      buildEnv: () => Record<string, string | undefined>,
      message: string,
    ]
  > = [
    [
      "KANTHORD_E2E_REAL_PLAN is absent",
      () => fakeContext(),
      () => ({ ...baseEnv(workDir), KANTHORD_E2E_REAL_PLAN: "" }),
      "P1-E5 needs KANTHORD_E2E_REAL_PLAN, in the environment or in .env.e2e",
    ],
    [
      "KANTHORD_E2E_REAL_OBJECTIVES is absent",
      () => fakeContext(),
      () => ({ ...baseEnv(workDir), KANTHORD_E2E_REAL_OBJECTIVES: "" }),
      "P1-E5 needs KANTHORD_E2E_REAL_OBJECTIVES, in the environment or in .env.e2e",
    ],
    [
      "KANTHORD_E2E_REAL_TASKS is absent",
      () => fakeContext(),
      () => ({ ...baseEnv(workDir), KANTHORD_E2E_REAL_TASKS: "" }),
      "P1-E5 needs KANTHORD_E2E_REAL_TASKS, in the environment or in .env.e2e",
    ],
  ];

  for (const [name, buildContext, buildEnv, message] of rows) {
    await t.test(name, async () => {
      await assert.rejects(
        checkPrerequisites(buildContext(), buildEnv(), stubLoadEnv()),
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

test("checkPrerequisites keeps plan and count inputs explicit instead of reading them from .env.e2e", async () => {
  await assert.rejects(
    Reflect.apply(checkPrerequisites, undefined, [
      fakeContext(),
      {},
      stubLoadEnv(),
      () => ({
        KANTHORD_E2E_REAL_PLAN: "/from/file",
        KANTHORD_E2E_REAL_OBJECTIVES: "2",
        KANTHORD_E2E_REAL_TASKS: "4",
      }),
    ]) as Promise<unknown>,
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "unavailable");
      assert.equal(
        error.message,
        "P1-E5 needs KANTHORD_E2E_REAL_PLAN, in the environment or in .env.e2e",
      );
      return true;
    },
  );
});

test("checkPrerequisites passes the run tag to loadE2eEnv as the run id, so no E2E_RUN_ID export is needed", async () => {
  const seen: (string | undefined)[] = [];
  const loadEnv = (
    overrides?: Readonly<{ file?: string; runId?: string }>,
  ): E2eEnv => {
    seen.push(overrides?.runId);
    return {
      ghToken: "gh-secret",
      ghRepo: "kanthorlabs/kanthord",
      ghBaseBranch: "main",
      runId: overrides?.runId ?? "",
    };
  };

  await checkPrerequisites(fakeContext(), baseEnv("/tmp/p1e5-plan"), loadEnv);

  assert.deepEqual(seen, ["p1e5-test"]);
});

test("checkPrerequisites refuses a context carrying a daemon host", async () => {
  await assert.rejects(
    checkPrerequisites(
      fakeContext({ daemonHost: "daemon.example" }),
      baseEnv("/tmp/p1e5-plan"),
      stubLoadEnv(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "invalid-argument");
      assert.equal(
        error.message,
        "P1-E5 runs on one machine and takes no host option",
      );
      return true;
    },
  );
});

test("checkPrerequisites refuses a context carrying a client host", async () => {
  await assert.rejects(
    checkPrerequisites(
      fakeContext({ clientHost: "client.example" }),
      baseEnv("/tmp/p1e5-plan"),
      stubLoadEnv(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "invalid-argument");
      assert.equal(
        error.message,
        "P1-E5 runs on one machine and takes no host option",
      );
      return true;
    },
  );
});

test("KANTHORD_E2E_REAL_OBJECTIVES=0 and a non-numeric value each reject as unavailable", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  for (const value of ["0", "not-a-number"]) {
    await t.test(`KANTHORD_E2E_REAL_OBJECTIVES=${value}`, async () => {
      const context = fakeContext();
      const env = { ...baseEnv(workDir), KANTHORD_E2E_REAL_OBJECTIVES: value };

      await assert.rejects(
        checkPrerequisites(context, env, stubLoadEnv()),
        (error: unknown) => {
          assert.ok(error instanceof RunnerError);
          assert.equal(error.code, "unavailable");
          return true;
        },
      );
    });
  }
});

test("checkPrerequisites resolves the RealInputs from the explicit plan and count inputs", async () => {
  const context = fakeContext();
  const env = {
    KANTHORD_E2E_REAL_PLAN: "/tmp/plan",
    KANTHORD_E2E_REAL_OBJECTIVES: "2",
    KANTHORD_E2E_REAL_TASKS: "4",
    KANTHORD_E2E_REAL_PENDING_TASKS: "2",
    KANTHORD_E2E_REAL_READY_TASKS: "2",
  };

  const result = await checkPrerequisites(context, env, stubLoadEnv());

  assert.deepEqual(result, {
    origin: "https://github.com/kanthorlabs/kanthord.git",
    defaultBranch: "main",
    token: "gh-secret",
    planPath: "/tmp/plan",
    expectedObjectiveCount: 2,
    expectedTaskCount: 4,
    expectedPendingTaskCount: 2,
    expectedReadyTaskCount: 2,
  });
});

test("KANTHORD_E2E_REAL_READY_TASKS=0 is accepted, and the resolved RealInputs carry both task-state counts", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const context = fakeContext();
  const env = {
    ...baseEnv(workDir),
    KANTHORD_E2E_REAL_READY_TASKS: "0",
  };

  const result = await checkPrerequisites(context, env, stubLoadEnv());

  assert.equal(result.expectedPendingTaskCount, 2);
  assert.equal(result.expectedReadyTaskCount, 0);
});

test("KANTHORD_E2E_REAL_READY_TASKS=-1 and KANTHORD_E2E_REAL_READY_TASKS=x each reject as unavailable", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  for (const value of ["-1", "x"]) {
    await t.test(`KANTHORD_E2E_REAL_READY_TASKS=${value}`, async () => {
      const context = fakeContext();
      const env = { ...baseEnv(workDir), KANTHORD_E2E_REAL_READY_TASKS: value };

      await assert.rejects(
        checkPrerequisites(context, env, stubLoadEnv()),
        (error: unknown) => {
          assert.ok(error instanceof RunnerError);
          assert.equal(error.code, "unavailable");
          return true;
        },
      );
    });
  }
});

test("a loadEnv rejection is wrapped as unavailable naming each missing key", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  try {
    const context = fakeContext();
    const env = baseEnv(workDir);
    const loadEnv = (): E2eEnv => {
      throw new E2eEnvError("boom", ["E2E_GH_TOKEN", "E2E_GH_REPO"]);
    };

    await assert.rejects(
      checkPrerequisites(context, env, loadEnv),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "unavailable");
        assert.equal(
          error.message,
          "P1-E5 needs E2E_GH_TOKEN, E2E_GH_REPO in .env.e2e",
        );
        return true;
      },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a loadEnv rejection naming all three required keys preserves E2E_REQUIRED_KEYS order", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  try {
    const context = fakeContext();
    const env = baseEnv(workDir);
    const loadEnv = (): E2eEnv => {
      throw new E2eEnvError("boom", [
        "E2E_GH_TOKEN",
        "E2E_GH_REPO",
        "E2E_GH_BASE_BRANCH",
      ]);
    };

    await assert.rejects(
      checkPrerequisites(context, env, loadEnv),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "unavailable");
        assert.equal(
          error.message,
          "P1-E5 needs E2E_GH_TOKEN, E2E_GH_REPO, E2E_GH_BASE_BRANCH in .env.e2e",
        );
        return true;
      },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("KANTHORD_E2E_REAL_ORIGIN, KANTHORD_E2E_REAL_BRANCH and KANTHORD_E2E_REAL_TOKEN_FILE absent from env does not reject", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-"));
  mkdirSync(join(workDir, "plan"), { recursive: true });
  try {
    const context = fakeContext();
    const env = baseEnv(workDir);
    assert.equal("KANTHORD_E2E_REAL_ORIGIN" in env, false);
    assert.equal("KANTHORD_E2E_REAL_BRANCH" in env, false);
    assert.equal("KANTHORD_E2E_REAL_TOKEN_FILE" in env, false);

    const result = await checkPrerequisites(context, env, stubLoadEnv());

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
  tokenFilePath?: string,
): ExecutionDriver {
  return {
    name: "local",
    async identity() {
      return { hostname: "p1e5-test", platform: "linux", architecture: "x64" };
    },
    async deliverBinary() {
      return "~/.kanthord-e2e-p1e5-test/bin/kanthord";
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
      return "~/.kanthord-e2e-p1e5-test/config.json";
    },
    async deliverToken(token: string) {
      deliverTokenCalls.push(token);
      if (tokenFilePath !== undefined) {
        writeFileSync(tokenFilePath, `${token}\n`, { mode: 0o600 });
        return tokenFilePath;
      }
      return "~/.kanthord-e2e-p1e5-test/token";
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
      const home = config?.home ?? "~/.kanthord-e2e-p1e5-test";
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
          "kanthord: node objective ready - 2\nkanthord: node task pending - 2\nkanthord: node task ready - 2\n",
      });
    }
    if (argv[0] === "run") {
      return record(argv, {
        exitCode: 220,
        stderr: "kanthord: not-implemented: run is not implemented\n",
      });
    }
    throw new Error(
      `unexpected cli invocation in the p1-e5 fake: ${argv.join(" ")}`,
    );
  };
}

async function withRealPlan<T>(
  body: (workDir: string) => Promise<T>,
): Promise<T> {
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-run-"));
  try {
    mkdirSync(join(workDir, "plan"), { recursive: true });
    writeFileSync(join(workDir, "plan", "objective.md"), "a real objective\n");
    return await body(workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const journeyAndForgeAssertionNames = [
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
  "forge-unchanged",
];

test("with a driver and every prerequisite present, runP1E5 calls runJourney exactly once, in the seventeen named order, then asserts forge unchanged, against a profile with fixtureRoot null and expectedObjectIds null", async (t) => {
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

    const context = fakeContext();
    t.after(() => context.releaseAll());
    const env = baseEnv(workDir);
    const inputs = await checkPrerequisites(context, env, stubLoadEnv());

    await runP1E5(context, driver, inputs, stableRemoteRefs);

    assert.deepEqual(context.assertionNames(), journeyAndForgeAssertionNames);
    assert.deepEqual(deliverDirectoryCalls, [
      ["client", inputs.planPath, "plan"],
    ]);
  });
});

test("runP1E5 calls deliverToken exactly once with the token, and passes origin, defaultBranch, localPlanPath, expectedObjectiveCount and expectedTaskCount straight through to createRealProfile", async (t) => {
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

    const context = fakeContext();
    t.after(() => context.releaseAll());

    const inputs: RealInputs = {
      origin: "https://github.com/kanthorlabs/kanthord.git",
      defaultBranch: "main",
      token: "gh-secret",
      planPath: join(workDir, "plan"),
      expectedObjectiveCount: 2,
      expectedTaskCount: 4,
      expectedPendingTaskCount: 2,
      expectedReadyTaskCount: 2,
    };

    await runP1E5(context, driver, inputs, stableRemoteRefs);

    assert.deepEqual(deliverTokenCalls, ["gh-secret"]);
    assert.equal(repositoryRegisterCalls.length, 1);
    assert.ok(repositoryRegisterCalls[0]?.includes(inputs.origin));
    assert.ok(repositoryRegisterCalls[0]?.includes(inputs.defaultBranch));
    assert.deepEqual(deliverDirectoryCalls, [
      ["client", inputs.planPath, "plan"],
    ]);
  });
});

test("runP1E5 reads the remote refs twice, with the same input both times", async (t) => {
  await withRealPlan(async (workDir) => {
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const driver = fakeDriver(
      planDeliveryDirectory,
      buildJourneyDispatch(planDeliveryDirectory),
      [],
    );
    const context = fakeContext();
    t.after(() => context.releaseAll());
    const inputs: RealInputs = {
      origin: "https://github.com/kanthorlabs/kanthord.git",
      defaultBranch: "main",
      token: "gh-secret",
      planPath: join(workDir, "plan"),
      expectedObjectiveCount: 2,
      expectedTaskCount: 4,
      expectedPendingTaskCount: 2,
      expectedReadyTaskCount: 2,
    };
    const readInputs: RemoteRefsInput[] = [];
    const readRemoteRefs: ReadRemoteRefs = async (remoteInput) => {
      readInputs.push(remoteInput);
      return { "refs/heads/main": "a".repeat(40) };
    };

    await runP1E5(context, driver, inputs, readRemoteRefs);

    assert.equal(readInputs.length, 2);
    assert.deepEqual(readInputs, [
      {
        origin: inputs.origin,
        username: "x-access-token",
        tokenPath: "~/.kanthord-e2e-p1e5-test/token",
      },
      {
        origin: inputs.origin,
        username: "x-access-token",
        tokenPath: "~/.kanthord-e2e-p1e5-test/token",
      },
    ]);
  });
});

test("runP1E5 reads the refs before the first journey command and after the last", async (t) => {
  await withRealPlan(async (workDir) => {
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const commands: CommandRecord[] = [];
    const dispatch = buildJourneyDispatch(planDeliveryDirectory);
    const driver = fakeDriver(
      planDeliveryDirectory,
      async (argv) => {
        const result = await dispatch(argv);
        commands.push(result);
        return result;
      },
      [],
    );
    const context = fakeContext();
    t.after(() => context.releaseAll());
    const inputs: RealInputs = {
      origin: "https://github.com/kanthorlabs/kanthord.git",
      defaultBranch: "main",
      token: "gh-secret",
      planPath: join(workDir, "plan"),
      expectedObjectiveCount: 2,
      expectedTaskCount: 4,
      expectedPendingTaskCount: 2,
      expectedReadyTaskCount: 2,
    };
    let readCount = 0;
    let commandCountAtSecondRead = -1;
    const readRemoteRefs: ReadRemoteRefs = async (): Promise<
      Readonly<Record<string, string>>
    > => {
      readCount += 1;
      if (readCount === 1) {
        assert.equal(commands.length, 0);
      } else {
        commandCountAtSecondRead = commands.length;
      }
      return { "refs/heads/main": "a".repeat(40) };
    };

    await runP1E5(context, driver, inputs, readRemoteRefs);

    assert.equal(readCount, 2);
    assert.ok(commands.length > 0);
    assert.equal(commandCountAtSecondRead, commands.length);
  });
});

test("runP1E5 asserts forge-unchanged with the two maps", async (t) => {
  await withRealPlan(async (workDir) => {
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const driver = fakeDriver(
      planDeliveryDirectory,
      buildJourneyDispatch(planDeliveryDirectory),
      [],
    );
    const context = fakeContext();
    t.after(() => context.releaseAll());
    const inputs: RealInputs = {
      origin: "https://github.com/kanthorlabs/kanthord.git",
      defaultBranch: "main",
      token: "gh-secret",
      planPath: join(workDir, "plan"),
      expectedObjectiveCount: 2,
      expectedTaskCount: 4,
      expectedPendingTaskCount: 2,
      expectedReadyTaskCount: 2,
    };
    const refs = { "refs/heads/main": "a".repeat(40) };

    await runP1E5(context, driver, inputs, async () => refs);

    const assertion = context
      .assertionRecords()
      .find((entry) => entry.name === "forge-unchanged");
    assert.ok(assertion);
    assert.deepEqual(assertion.expected, refs);
    assert.deepEqual(assertion.actual, refs);
  });
});

test("runP1E5 records forge-unchanged as failed when a ref appears during the journey", async (t) => {
  await withRealPlan(async (workDir) => {
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const driver = fakeDriver(
      planDeliveryDirectory,
      buildJourneyDispatch(planDeliveryDirectory),
      [],
    );
    const context = fakeContext();
    t.after(() => context.releaseAll());
    const inputs: RealInputs = {
      origin: "https://github.com/kanthorlabs/kanthord.git",
      defaultBranch: "main",
      token: "gh-secret",
      planPath: join(workDir, "plan"),
      expectedObjectiveCount: 2,
      expectedTaskCount: 4,
      expectedPendingTaskCount: 2,
      expectedReadyTaskCount: 2,
    };
    let readCount = 0;
    const readRemoteRefs: ReadRemoteRefs = async (): Promise<
      Readonly<Record<string, string>>
    > => {
      readCount += 1;
      if (readCount === 1) {
        return { "refs/heads/main": "a".repeat(40) };
      }
      return {
        "refs/heads/main": "a".repeat(40),
        "refs/heads/created-during-run": "b".repeat(40),
      };
    };

    await assert.rejects(
      runP1E5(context, driver, inputs, readRemoteRefs),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "forge-unchanged");
        return true;
      },
    );

    const assertion = context
      .assertionRecords()
      .find((entry) => entry.name === "forge-unchanged");
    assert.ok(assertion);
    assert.notDeepEqual(assertion.expected, assertion.actual);
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
      expectedPendingTaskCount: 2,
      expectedReadyTaskCount: 2,
    };

    await runP1E5(context, driver, inputs, stableRemoteRefs);

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

test("SECURITY: P1-E5 serializes no token and removes its 0600 token file after ledger cleanup", async (t) => {
  await withRealPlan(async (workDir) => {
    const planDeliveryDirectory = join(workDir, "delivered", "plan");
    mkdirSync(planDeliveryDirectory, { recursive: true });
    writeFileSync(
      join(planDeliveryDirectory, "objective.md"),
      "a real objective\n",
    );

    const token = "p1e5-bundle-token-file-secret";
    const tokenFilePath = join(workDir, "token");
    const writer = createBundleWriter({
      scenarioId: "P1-E5",
      mode: "integration",
      driver: "local",
      profile: "real",
      tag: "p1e5-security-bundle",
      commit: "commit-p1e5-security",
      startedAt: "2026-08-09T00:00:00.000Z",
      identity: {
        hostname: "p1e5-test",
        platform: "darwin",
        architecture: "arm64",
      },
      fixtureHashes: [],
    });
    const context = fakeContext({
      sink: writer.sink,
      assert: writer.assert,
      noteObject: writer.noteObject,
      attachLog: writer.attachLog,
      logs: writer.logs,
      printedLines: writer.printedLines,
      commandsRecorded: writer.commandsRecorded,
    });
    t.after(() => context.releaseAll());

    const dispatch = buildJourneyDispatch(planDeliveryDirectory);
    const driver = fakeDriver(
      planDeliveryDirectory,
      async (argv) => {
        const dispatched = await dispatch(argv);
        const result =
          argv[0] === "credential"
            ? { ...dispatched, stderr: `${dispatched.stderr}${token}\n` }
            : dispatched;
        context.sink.record(result);
        return result;
      },
      [],
      [],
      tokenFilePath,
    );

    await runP1E5(
      context,
      driver,
      {
        origin: "https://github.com/kanthorlabs/kanthord.git",
        defaultBranch: "main",
        token,
        planPath: join(workDir, "plan"),
        expectedObjectiveCount: 2,
        expectedTaskCount: 4,
        expectedPendingTaskCount: 2,
        expectedReadyTaskCount: 2,
      },
      stableRemoteRefs,
    );

    const bundle = writer.finish({
      outcome: "passed",
      cleanupFailures: [],
      finishedAt: "2026-08-09T00:05:00.000Z",
    });
    const serialized = serializeBundle(bundle);

    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("[redacted]"), true);
    assert.equal(existsSync(tokenFilePath), true);
    assert.equal(statSync(tokenFilePath).mode & 0o777, 0o600);

    await context.releaseAll();

    assert.equal(existsSync(tokenFilePath), false);
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

test("on a prerequisite failure, main resolves exit code 3 and writes a bundle with outcome unavailable, an empty assertions array and no passed key", async (t) => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e5-main-"));
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await main(["P1-E5", "--tag", "t1"]);
  assert.equal(code, 3);

  const bundleText = await readFile(
    ".data/acceptance-t1/P1-E5/bundle.json",
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

test("p1e5 declares P1-E5, mode integration, driver local, profile real", () => {
  assert.equal(p1e5.id, "P1-E5");
  assert.equal(p1e5.mode, "integration");
  assert.equal(p1e5.driver, "local");
  assert.equal(p1e5.profile, "real");
});
