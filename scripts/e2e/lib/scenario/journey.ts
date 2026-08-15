import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, sep } from "node:path";

import type { DaemonConfig, ExecutionDriver } from "../driver/index.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import { takeTemporaryDirectory } from "../resources.ts";
import type { ScenarioContext } from "./context.ts";
import { resolveTools } from "./tools.ts";

export type PlanDocument = Readonly<{ path: string; bytes: Buffer }>;

export type JourneyResult = Readonly<{
  credentialId: string;
  repositoryId: string;
  projectId: string;
  firstRevision: string;
  secondRevision: string;
  accepted: readonly PlanDocument[];
  token: string;
}>;

async function allocateEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function byPathBytes(left: PlanDocument, right: PlanDocument): number {
  return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

async function readTree(root: string): Promise<PlanDocument[]> {
  const documents: PlanDocument[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = relative(root, fullPath).split(sep).join("/");
        const bytes = await readFile(fullPath);
        documents.push({ path: relativePath, bytes });
      }
    }
  }

  await walk(root);
  return documents.sort(byPathBytes);
}

function parseStatusCounts(stdout: string): Readonly<{
  objectiveCount: number;
  taskCount: number;
  taskStates: Readonly<Record<string, number>>;
}> {
  let objectiveCount = 0;
  let taskCount = 0;
  const taskStates: Record<string, number> = {};

  for (const match of stdout.matchAll(
    /^kanthord: node (\S+) (\S+) (\S+) (\d+)$/gm,
  )) {
    const kind = match[1];
    const state = match[2] as string;
    const count = Number(match[4]);
    if (kind === "objective") {
      objectiveCount += count;
    }
    if (kind === "task") {
      taskCount += count;
      taskStates[state] = (taskStates[state] ?? 0) + count;
    }
  }

  return { objectiveCount, taskCount, taskStates };
}

export async function runJourney(
  context: ScenarioContext,
  driver: ExecutionDriver,
  profile: ScenarioProfile,
): Promise<JourneyResult> {
  await driver.assertBareMachine();

  const workspace = await takeTemporaryDirectory(
    context,
    "kanthord-e2e-journey-",
  );

  const network = (await driver.daemonNetwork?.()) ?? {
    bind: "127.0.0.1",
    port: await allocateEphemeralPort(),
    allowedHosts: [] as readonly string[],
  };
  const allowedHosts =
    network.allowedHosts.length > 0
      ? network.allowedHosts
      : [`${network.bind}:${String(network.port)}`];

  const refusal = await driver.startDaemonExpectingRefusal(null);
  context.assert("no-config-exit", 1, refusal.exitCode);
  const homeDirectory = refusal.homeDirectory ?? refusal.cwd;
  const searchOrderCandidates = [
    join(refusal.cwd, "kanthord.config.json"),
    join(homeDirectory, ".config", "kanthord", "config.json"),
    join("/etc", "kanthord", "config.json"),
  ];
  context.assert(
    "no-config-names-search-order",
    `kanthord: config-not-found: no config file found; searched: ${searchOrderCandidates.join(", ")}\n`,
    refusal.stderr,
  );

  const daemonConfig: DaemonConfig = {
    home: refusal.cwd,
    actor: "e2e-journey",
    masterKey: randomBytes(32).toString("base64"),
    http: {
      bind: network.bind,
      port: network.port,
      token: randomBytes(16).toString("hex"),
      allowedHosts,
    },
    tools: resolveTools(),
    attemptLimit: 3,
  };

  const handle = await driver.startDaemon(daemonConfig);
  const startLogs = await handle.logs();
  context.assert(
    "first-location-starts",
    true,
    startLogs.stdout.includes("kanthord: ready\n"),
  );

  const versionRecord = await driver.cli(["--version"]);
  const statusResponse = await driver.issue({
    method: "GET",
    path: "/v1/status",
    headers: {
      Authorization: `Bearer ${daemonConfig.http.token}`,
    },
    omitHost: false,
  });
  const statusParsed = JSON.parse(statusResponse.body) as Readonly<{
    version: unknown;
  }>;
  context.assert(
    "version-parity",
    {
      exitCode: 0,
      cliVersion: statusParsed.version,
      daemonVersion: statusParsed.version,
    },
    {
      exitCode: versionRecord.exitCode,
      cliVersion: versionRecord.stdout.trim(),
      daemonVersion: statusParsed.version,
    },
  );

  const credentialRecord = await driver.cli([
    "credential",
    "register",
    ...profile.credentialArguments,
  ]);
  const credentialMatch = /^kanthord: registered (\S+) (\S+)$/m.exec(
    credentialRecord.stdout,
  );
  context.assert(
    "credential-registered",
    true,
    credentialRecord.exitCode === 0 && credentialMatch !== null,
  );
  const credentialId = credentialMatch?.[2] ?? "";

  const repositoryRecord = await driver.cli([
    "repository",
    "register",
    "--name",
    profile.name,
    "--url",
    profile.origin,
    "--credential",
    profile.name,
    "--upstream",
    profile.defaultBranch,
  ]);
  const repositoryMatch = /^kanthord: registered (\S+) (\S+)$/m.exec(
    repositoryRecord.stdout,
  );
  context.assert(
    "repository-registered",
    true,
    repositoryRecord.exitCode === 0 &&
      repositoryMatch !== null &&
      repositoryRecord.stdout.includes(
        `kanthord: upstream ${profile.defaultBranch}`,
      ),
  );
  const repositoryId = repositoryMatch?.[2] ?? "";

  const showRecord = await driver.cli([
    "repository",
    "show",
    "--id",
    repositoryId,
  ]);
  const landingLines = [
    ...showRecord.stdout.matchAll(/^kanthord: landing \S+ \S+$/gm),
  ].length;
  const trackingLines = [
    ...showRecord.stdout.matchAll(/^kanthord: tracking \S+ \S+$/gm),
  ].length;
  context.assert(
    "ref-layout",
    true,
    showRecord.exitCode === 0 && landingLines === 1 && trackingLines === 1,
  );

  const projectRecord = await driver.cli([
    "project",
    "create",
    "--name",
    "journey",
  ]);
  const projectMatch = /^kanthord: project (\S+)$/m.exec(projectRecord.stdout);
  context.assert(
    "project-created",
    true,
    projectRecord.exitCode === 0 &&
      projectMatch !== null &&
      projectRecord.stdout.includes("kanthord: name journey"),
  );
  const projectId = projectMatch?.[1] ?? "";

  const bindRecord = await driver.cli([
    "project",
    "repository",
    "--id",
    projectId,
    "--repository",
    profile.name,
  ]);
  context.assert("repository-bound", true, bindRecord.exitCode === 0);

  const planRoot = dirname(profile.planDirectory);
  const importRecord = await driver.cli([
    "plan",
    "import",
    "--project",
    projectId,
    "--directory",
    planRoot,
  ]);
  const firstRevisionMatch = /^kanthord: revision (\S+)$/m.exec(
    importRecord.stdout,
  );
  context.assert(
    "plan-imported",
    true,
    importRecord.exitCode === 0 && firstRevisionMatch !== null,
  );
  const firstRevision = firstRevisionMatch?.[1] ?? "";

  const acceptedDirectory = join(workspace, "accepted");
  await driver.retrieveDirectory("client", planRoot, acceptedDirectory);
  const accepted = await readTree(acceptedDirectory);

  const exportDirectory = join(workspace, "export");
  await driver.cli([
    "plan",
    "export",
    "--project",
    projectId,
    "--directory",
    exportDirectory,
  ]);
  const exportedDirectory = join(workspace, "exported");
  await driver.retrieveDirectory("client", exportDirectory, exportedDirectory);
  const exported = await readTree(exportedDirectory);
  context.assert("export-byte-identical", accepted, exported);

  const reimportRecord = await driver.cli([
    "plan",
    "import",
    "--project",
    projectId,
    "--directory",
    planRoot,
  ]);
  context.assert("reimport-same-revision", 0, reimportRecord.exitCode);
  const secondRevisionMatch = /^kanthord: revision (\S+)$/m.exec(
    reimportRecord.stdout,
  );
  const secondRevision = secondRevisionMatch?.[1] ?? "";
  const cliChoices = new Map(
    [
      ...reimportRecord.stdout.matchAll(
        /^kanthord: (\S+) -> (submitted|database)$/gm,
      ),
    ].map((match) => [match[1]!, match[2]!]),
  );
  const validateResponse = await driver.issue({
    method: "POST",
    path: `/v1/project/${projectId}/plan/validate`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonConfig.http.token}`,
    },
    omitHost: false,
    body: JSON.stringify({
      fromRevision: firstRevision,
      documents: accepted.map((document) => ({
        path: document.path,
        content: document.bytes.toString("utf8"),
      })),
    }),
  });
  const validateParsed = JSON.parse(validateResponse.body) as Readonly<{
    choices: readonly Readonly<{ id: string; suggested: string }>[];
  }>;
  const suggestedChoices = new Map(
    validateParsed.choices.map((choice) => [choice.id, choice.suggested]),
  );
  context.assert(
    "reimport-choices-suggested",
    true,
    cliChoices.size > 0 &&
      [...cliChoices.entries()].every(
        ([id, take]) => suggestedChoices.get(id) === take,
      ),
  );

  const staleBody = JSON.stringify({
    fromRevision: firstRevision,
    importId: `imp_e2e_stale_${Date.now()}`,
    documents: [{ path: "plan/probe.md", content: "probe\n" }],
    choices: [],
    validatedRevision: null,
    documentsHash: `sha256:${"0".repeat(64)}`,
  });
  const staleResponse = await driver.issue({
    method: "POST",
    path: `/v1/project/${projectId}/plan/import`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonConfig.http.token}`,
    },
    omitHost: false,
    body: staleBody,
  });
  const staleParsed = JSON.parse(staleResponse.body) as Record<string, unknown>;
  const staleEnvelope =
    (staleParsed.error as Record<string, unknown> | undefined) ?? staleParsed;
  const staleDetails = staleEnvelope.details as
    Readonly<{ current?: unknown }> | undefined;
  context.assert(
    "reimport-stale-revision",
    { status: 409, code: "stale-revision", current: secondRevision },
    {
      status: staleResponse.status,
      code: staleEnvelope.code,
      current: staleDetails?.current,
    },
  );

  const firstStatusRecord = await driver.cli([
    "status",
    "--project",
    projectId,
  ]);
  const firstStatusCounts = parseStatusCounts(firstStatusRecord.stdout);
  const expectedTaskStates: Record<string, number> = {};
  if (profile.expectedPendingTaskCount > 0) {
    expectedTaskStates["pending"] = profile.expectedPendingTaskCount;
  }
  if (profile.expectedReadyTaskCount > 0) {
    expectedTaskStates["ready"] = profile.expectedReadyTaskCount;
  }

  context.assert(
    "status-counts",
    {
      exitCode: 0,
      objectiveCount: profile.expectedObjectiveCount,
      taskCount: profile.expectedTaskCount,
      taskStates: expectedTaskStates,
    },
    {
      exitCode: firstStatusRecord.exitCode,
      objectiveCount: firstStatusCounts.objectiveCount,
      taskCount: firstStatusCounts.taskCount,
      taskStates: firstStatusCounts.taskStates,
    },
  );

  const runRecord = await driver.cli(["run", "--project", projectId]);
  context.assert(
    "run-not-implemented",
    { exitCode: 220, matchesNotImplemented: true },
    {
      exitCode: runRecord.exitCode,
      matchesNotImplemented: /^kanthord: not-implemented:/m.test(
        runRecord.stderr,
      ),
    },
  );

  const secondStatusRecord = await driver.cli([
    "status",
    "--project",
    projectId,
  ]);
  context.assert(
    "status-unchanged",
    firstStatusRecord.stdout,
    secondStatusRecord.stdout,
  );

  context.noteObject?.("credentialId", credentialId);
  context.noteObject?.("repositoryId", repositoryId);
  context.noteObject?.("projectId", projectId);
  context.noteObject?.("firstRevision", firstRevision);
  context.noteObject?.("secondRevision", secondRevision);
  for (const document of accepted) {
    context.attachLog?.(document.path, document.bytes.toString("utf8"));
  }

  return {
    credentialId,
    repositoryId,
    projectId,
    firstRevision,
    secondRevision,
    accepted,
    token: daemonConfig.http.token,
  };
}
