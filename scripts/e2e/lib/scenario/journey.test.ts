import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { runJourney } from "./journey.ts";
import type {
  ExecutionDriver,
  DaemonConfig,
  DaemonHandle,
} from "../driver/index.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import type { ScenarioContext } from "./context.ts";
import type { CommandRecord } from "../command.ts";
import { RunnerError } from "../errors.ts";
import { createLedger, type Ledger } from "../resources.ts";
import { searchOrder } from "../../../../src/services/config/search-order.ts";
import { KANTHORD_VERSION } from "../../../../src/domain/version.ts";

// `ScenarioContext` (Story 02) does not yet declare `noteObject`/`attachLog` —
// Story 04's own text requires both. See the RED turn's "Open to Software
// Engineer" note: this is the extended shape the seam needs.
type JourneyContext = ScenarioContext & {
  noteObject(key: string, id: string): void;
  attachLog(name: string, text: string): void;
};

type AssertionRecord = Readonly<{
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}>;

type SinkCommand = CommandRecord;

const acceptedFiles: Readonly<Record<string, string>> = {
  "plan/alpha/objective.md": "alpha objective content\n",
  "plan/beta/objective.md": "beta objective content\n",
};

const authoredFiles: Readonly<Record<string, string>> = {
  "plan/alpha/objective.md": "authored alpha, no identity\n",
  "plan/beta/objective.md": "authored beta, no identity\n",
};

const statusStdout =
  "kanthord: node initiative pending - 1\n" +
  "kanthord: node objective pending - 2\n" +
  "kanthord: node task pending - 4\n";

async function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

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

function findFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

type CliStep = (
  argv: readonly string[],
) => CommandRecord | Promise<CommandRecord>;

type FixtureOverrides = Readonly<{
  workDir: string;
  take: Ledger["take"];
  searchOrderStderr?: (candidates: readonly string[]) => string;
  exportContent?: Readonly<Record<string, string>>;
  staleRevisionExpects?: string;
  runExitCode?: number;
  secondStatusStdout?: string;
  bareMachinePresent?: boolean;
  systemStatusVersion?: string;
  reimportSuggestedChoices?: readonly Readonly<{
    id: string;
    suggested: string;
  }>[];
}>;

const defaultReimportSuggestedChoices: readonly Readonly<{
  id: string;
  suggested: string;
}>[] = [
  { id: "plan/alpha/objective.md", suggested: "database" },
  { id: "plan/beta/objective.md", suggested: "database" },
];

const systemStatusBody: Readonly<{
  bind: string;
  startedAt: string;
  status: "ok";
  dependencies: readonly unknown[];
  nodes: readonly unknown[];
  repositories: readonly unknown[];
  leases: readonly unknown[];
}> = {
  bind: "127.0.0.1:9999",
  startedAt: "2025-01-01T00:00:00.000Z",
  status: "ok",
  dependencies: [],
  nodes: [],
  repositories: [],
  leases: [],
};

function buildFixture(overrides: FixtureOverrides): Readonly<{
  driver: ExecutionDriver;
  profile: ScenarioProfile;
  context: JourneyContext;
  assertions: AssertionRecord[];
  commands: SinkCommand[];
  issueCalls: number;
  issuedRequests: Array<{ method: string; path: string }>;
}> {
  const assertions: AssertionRecord[] = [];
  const commands: SinkCommand[] = [];
  const issuedRequests: Array<{ method: string; path: string }> = [];
  let issueCalls = 0;
  let planImportCalls = 0;
  let statusProjectCalls = 0;

  const profile: ScenarioProfile = {
    name: "fixture",
    origin: "http://127.0.0.1:9/fixture.git",
    credentialArguments: [
      "--name",
      "fixture",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--token-file",
      join(overrides.workDir, "fixture-token"),
    ],
    defaultBranch: "main",
    planDirectory: join(overrides.workDir, "plan-directory"),
    expectedObjectiveCount: 2,
    expectedTaskCount: 4,
    fixtureRoot: join(overrides.workDir, "plan-directory"),
    expectedObjectIds: { alpha: "alpha-id", beta: "beta-id" },
  };

  const cliSteps: CliStep[] = [
    // --version
    () => record(["--version"], { stdout: `${KANTHORD_VERSION}\n` }),
    // credential register
    () =>
      record(["credential", "register", ...profile.credentialArguments], {
        stdout: "kanthord: registered fixture cred_1\n",
      }),
    // repository register
    () =>
      record(
        [
          "repository",
          "register",
          "--name",
          "fixture",
          "--url",
          profile.origin,
          "--credential",
          "fixture",
          "--upstream",
          profile.defaultBranch,
        ],
        {
          stdout:
            "kanthord: registered fixture repo_1\n" +
            "kanthord: upstream main\n" +
            "kanthord: landing refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
            "kanthord: tracking refs/remotes/origin/main bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" +
            "kanthord: publish refs/heads/main\n" +
            "kanthord: state clean\n",
        },
      ),
    // repository show
    () =>
      record(["repository", "show", "--id", "repo_1"], {
        stdout:
          "kanthord: registered fixture repo_1\n" +
          "kanthord: upstream main\n" +
          "kanthord: landing refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
          "kanthord: tracking refs/remotes/origin/main bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" +
          "kanthord: publish refs/heads/main\n" +
          "kanthord: state clean\n" +
          "kanthord: credential fixture cred_1\n",
      }),
    // project create
    () =>
      record(["project", "create", "--name", "journey"], {
        stdout:
          "kanthord: project proj_1\n" +
          "kanthord: name journey\n" +
          "kanthord: repositories <none>\n",
      }),
    // project repository (bind)
    () =>
      record(
        ["project", "repository", "--id", "proj_1", "--repository", "fixture"],
        {
          stdout:
            "kanthord: project proj_1\n" +
            "kanthord: name journey\n" +
            "kanthord: repositories repo_1\n",
        },
      ),
    // plan import (first) / plan import (reimport) — dispatched below
    async (argv) => {
      const directory = findFlag(argv, "--directory");
      assert.ok(
        directory !== undefined,
        "plan import argv must carry --directory",
      );
      planImportCalls += 1;
      if (planImportCalls === 1) {
        await writeTree(directory, acceptedFiles);
        return record(argv, {
          stdout:
            "kanthord: revision rev_1\n" +
            "kanthord: wrote 2 document\n" +
            "kanthord: removed 0 document\n" +
            "kanthord: absent <none>\n",
        });
      }
      return record(argv, {
        stdout:
          "kanthord: plan/alpha/objective.md -> database\n" +
          "kanthord: plan/beta/objective.md -> database\n" +
          "kanthord: revision rev_2\n" +
          "kanthord: wrote 2 document\n" +
          "kanthord: removed 0 document\n" +
          "kanthord: absent <none>\n",
      });
    },
    // plan export
    async (argv) => {
      const directory = findFlag(argv, "--directory");
      assert.ok(
        directory !== undefined,
        "plan export argv must carry --directory",
      );
      await writeTree(directory, overrides.exportContent ?? acceptedFiles);
      return record(argv, {
        stdout:
          "kanthord: revision rev_1\n" +
          "kanthord: wrote 2 document\n" +
          "kanthord: removed 0 document\n",
      });
    },
    // status --project (first)
    () => {
      statusProjectCalls += 1;
      if (statusProjectCalls === 1) {
        return record(["status", "--project", "proj_1"], {
          stdout: statusStdout,
        });
      }
      return record(["status", "--project", "proj_1"], {
        stdout: overrides.secondStatusStdout ?? statusStdout,
      });
    },
    // run --project
    () =>
      record(["run", "--project", "proj_1"], {
        exitCode: overrides.runExitCode ?? 220,
        stderr:
          overrides.runExitCode === 0
            ? ""
            : "kanthord: not-implemented: run is not implemented\n",
      }),
    // status --project (second)
    () => {
      statusProjectCalls += 1;
      return record(["status", "--project", "proj_1"], {
        stdout: overrides.secondStatusStdout ?? statusStdout,
      });
    },
  ];

  const dispatch: CliStep[] = [
    cliSteps[0]!,
    cliSteps[1]!,
    cliSteps[2]!,
    cliSteps[3]!,
    cliSteps[4]!,
    cliSteps[5]!,
    cliSteps[6]!, // plan import #1
    cliSteps[7]!, // plan export
    cliSteps[6]!, // plan import #2 (reimport) — same handler, counts itself
    cliSteps[8]!, // status #1
    cliSteps[9]!, // run
    cliSteps[10]!, // status #2
  ];

  let cliIndex = 0;

  const sink = {
    print(): void {},
    record(entry: CommandRecord): void {
      commands.push(entry);
    },
  };

  const driver: ExecutionDriver = {
    name: "local",
    async identity() {
      return {
        hostname: "journey-test",
        platform: "linux",
        architecture: "x64",
      };
    },
    async deliverBinary() {
      return "/usr/local/bin/kanthord";
    },
    async deliverDirectory(_role, _source, name) {
      return join(overrides.workDir, name);
    },
    async retrieveDirectory(_role, source, destination) {
      await cp(source, destination, { recursive: true });
    },
    async deliverConfig() {
      return join(overrides.workDir, "config.json");
    },
    async deliverToken() {
      return join(overrides.workDir, "token");
    },
    async assertBareMachine() {
      if (overrides.bareMachinePresent === true) {
        throw new RunnerError(
          "unavailable",
          "/etc/kanthord/config.json exists on the daemon host; P1-E1 needs a bare machine",
        );
      }
    },
    async cli(argv: readonly string[]): Promise<CommandRecord> {
      const step = dispatch[cliIndex];
      cliIndex += 1;
      if (step === undefined) {
        throw new Error(`unexpected 13th+ cli invocation: ${argv.join(" ")}`);
      }
      const result = await step(argv);
      sink.record(result);
      return result;
    },
    issue: async (request) => {
      issuedRequests.push({ method: request.method, path: request.path });
      if (request.method === "GET" && request.path === "/v1/status") {
        return {
          status: 200,
          body: JSON.stringify({
            version: overrides.systemStatusVersion ?? KANTHORD_VERSION,
            ...systemStatusBody,
          }),
        };
      }
      if (
        request.method === "POST" &&
        request.path === "/v1/project/proj_1/plan/validate"
      ) {
        return {
          status: 200,
          body: JSON.stringify({
            choices:
              overrides.reimportSuggestedChoices ??
              defaultReimportSuggestedChoices,
          }),
        };
      }
      issueCalls += 1;
      const body: Readonly<{ fromRevision: string | null }> =
        request.body === undefined
          ? { fromRevision: null }
          : (JSON.parse(request.body) as Readonly<{
              fromRevision: string | null;
            }>);
      const expectStale = overrides.staleRevisionExpects ?? "rev_1";
      if (body.fromRevision === expectStale) {
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
      const startRecord = record(["kanthord", "serve"], {
        cwd: config.home,
        stdout: "kanthord: ready\n",
      });
      sink.record(startRecord);
      return {
        baseUrl: "http://127.0.0.1:9999",
        allowedHost: "127.0.0.1:9999",
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
      const home = config?.home ?? overrides.workDir;
      const candidates = searchOrder({
        env: {},
        cwd: home,
        homeDir: home,
        etcDir: "/etc",
      });
      const stderr = overrides.searchOrderStderr
        ? overrides.searchOrderStderr(candidates)
        : `kanthord: config-not-found: no config file found; searched: ${candidates.join(", ")}\n`;
      const refusal = record(["kanthord", "serve"], {
        cwd: home,
        exitCode: 1,
        stderr,
      });
      sink.record(refusal);
      return refusal;
    },
    async collectLogs() {
      return {};
    },
  };

  const context: JourneyContext = {
    tag: "journey-test",
    scenarioId: "P1-E1",
    bundleDirectory: join(overrides.workDir, "bundle"),
    take: overrides.take,
    sink,
    assert(name: string, expected: unknown, actual: unknown): void {
      let passed = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }
      assertions.push({ name, passed, expected, actual });
      if (!passed) {
        throw new RunnerError("assertion-failed", name);
      }
    },
    noteObject(): void {},
    attachLog(): void {},
    daemonHost: null,
    clientHost: null,
  };

  return {
    driver,
    profile,
    context,
    assertions,
    commands,
    issueCalls: 0,
    issuedRequests,
  };
}

const expectedAssertionNames = [
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
] as const;

async function withWorkDir<T>(
  body: (workDir: string, take: Ledger["take"]) => Promise<T>,
): Promise<T> {
  const workDir = await mkdtemp(join(tmpdir(), "journey-test-"));
  const ledger = createLedger();
  try {
    return await body(workDir, ledger.take);
  } finally {
    await ledger.releaseAll();
    await rm(workDir, { recursive: true, force: true });
  }
}

test("runJourney issues exactly fourteen invocations, records the seventeen named assertions in order, and resolves the JourneyResult", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({ workDir, take });

    assert.notDeepEqual(acceptedFiles, authoredFiles);

    const result = await runJourney(
      fixture.context,
      fixture.driver,
      fixture.profile,
    );

    assert.equal(fixture.commands.length, 14);
    for (const entry of fixture.commands) {
      assert.equal(entry.argv.includes("--from-revision"), false);
    }

    assert.deepEqual(
      fixture.assertions.map((entry) => entry.name),
      expectedAssertionNames,
    );
    for (const entry of fixture.assertions) {
      assert.equal(entry.passed, true, `assertion ${entry.name} did not pass`);
    }

    assert.equal(result.credentialId, "cred_1");
    assert.equal(result.repositoryId, "repo_1");
    assert.equal(result.projectId, "proj_1");
    assert.equal(result.firstRevision, "rev_1");
    assert.equal(result.secondRevision, "rev_2");

    const sortedAccepted = [...result.accepted].sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    );
    assert.deepEqual(
      sortedAccepted.map((document) => document.path),
      Object.keys(acceptedFiles).sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
    for (const document of sortedAccepted) {
      assert.equal(
        Buffer.compare(
          document.bytes,
          Buffer.from(acceptedFiles[document.path]!, "utf8"),
        ),
        0,
      );
    }
  });
});

test("SECURITY: a driver with no retrieveDirectory rejects instead of silently falling back to a local filesystem copy", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({ workDir, take });
    const { retrieveDirectory: _unused, ...driverWithoutRetrieve } =
      fixture.driver;
    const driver = driverWithoutRetrieve as ExecutionDriver;

    await assert.rejects(runJourney(fixture.context, driver, fixture.profile));
  });
});

test("a driver reporting /etc/kanthord/config.json present rejects with RunnerError unavailable before any invocation", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({ workDir, take, bareMachinePresent: true });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "unavailable");
        return true;
      },
    );

    assert.equal(fixture.commands.length, 0);
  });
});

test("a fake whose step-2 stderr omits one search-order path rejects naming no-config-names-search-order", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({
      workDir,
      take,
      searchOrderStderr: (candidates) =>
        `kanthord: config-not-found: no config file found; searched: ${candidates.slice(0, -1).join(", ")}\n`,
    });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "no-config-names-search-order");
        return true;
      },
    );
  });
});

test("a fake whose export differs from the accepted set by one byte rejects naming export-byte-identical", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({
      workDir,
      take,
      exportContent: {
        ...acceptedFiles,
        "plan/alpha/objective.md": "alpha objective CONTENT\n",
      },
    });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "export-byte-identical");
        return true;
      },
    );
  });
});

test("a fake that names secondRevision instead of firstRevision as the stale boundary rejects naming reimport-stale-revision", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({
      workDir,
      take,
      staleRevisionExpects: "rev_2",
    });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "reimport-stale-revision");
        return true;
      },
    );
  });
});

test("a fake whose run exit code is 0 rejects naming run-not-implemented", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({ workDir, take, runExitCode: 0 });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "run-not-implemented");
        return true;
      },
    );
  });
});

test("a fake whose second status differs from the first only in trailing whitespace rejects naming status-unchanged", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({
      workDir,
      take,
      secondStatusStdout: `${statusStdout} `,
    });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "status-unchanged");
        return true;
      },
    );
  });
});

test("runJourney issues a GET to /v1/status and compares its version field against the CLI's, not just a semver shape", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({ workDir, take });

    await runJourney(fixture.context, fixture.driver, fixture.profile);

    assert.equal(
      fixture.issuedRequests.some(
        (entry) => entry.method === "GET" && entry.path === "/v1/status",
      ),
      true,
    );
  });
});

test("a fake whose GET /v1/status reports a version other than the CLI's rejects naming version-parity", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({
      workDir,
      take,
      systemStatusVersion: "0.0.0",
    });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "version-parity");
        return true;
      },
    );
  });
});

test("a fake whose independently-fetched suggested choice differs from what the CLI printed rejects naming reimport-choices-suggested", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({
      workDir,
      take,
      reimportSuggestedChoices: [
        { id: "plan/alpha/objective.md", suggested: "submitted" },
        { id: "plan/beta/objective.md", suggested: "database" },
      ],
    });

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, fixture.profile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "reimport-choices-suggested");
        return true;
      },
    );
  });
});

test("a profile whose expectedObjectiveCount does not match the daemon's count rejects naming status-counts", async () => {
  await withWorkDir(async (workDir, take) => {
    const fixture = buildFixture({ workDir, take });
    const brokenProfile: ScenarioProfile = {
      ...fixture.profile,
      expectedObjectiveCount: 3,
    };

    await assert.rejects(
      runJourney(fixture.context, fixture.driver, brokenProfile),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "assertion-failed");
        assert.equal(error.message, "status-counts");
        return true;
      },
    );
  });
});
