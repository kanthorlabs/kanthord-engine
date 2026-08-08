import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { runP1E4 } from "./p1-e4.ts";
import type { ScenarioContext } from "./context.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import { createLedger, type ResourceHandle } from "../resources.ts";
import { secrets } from "../redact.ts";
import { RunnerError } from "../errors.ts";
import type { CommandRecord } from "../command.ts";
import type { PodmanExecutor } from "../driver/podman.ts";
import { baseImageReference } from "../podman/preflight.ts";
import {
  planTopology,
  daemonHomeMountPath,
  tokenMountPath,
} from "../podman/topology.ts";
import type { BundleIdentity, BundleVersions } from "../bundle.ts";

const runId = "R1";
const topology = planTopology(runId);

function record(
  argv: readonly string[],
  stdout: string,
  exitCode = 0,
  stderr = "",
): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode, stdout, stderr };
}

function buildProfile(workDir: string): ScenarioProfile {
  // nested under "plan-directory/plan" so dirname(planDirectory) (journey.ts's
  // planRoot) contains only "plan/objective.md" — matching the export fake's
  // "plan/objective.md" write below, byte-for-byte, with no stray siblings.
  const planDirectory = join(workDir, "plan-directory", "plan");
  mkdirSync(planDirectory, { recursive: true });
  writeFileSync(join(planDirectory, "objective.md"), "an objective\n");

  return {
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
      join(workDir, "fixture-token"),
    ],
    defaultBranch: "main",
    planDirectory,
    expectedObjectiveCount: 2,
    expectedTaskCount: 4,
    fixtureRoot: planDirectory,
    expectedObjectIds: { alpha: "alpha-id", beta: "beta-id" },
  };
}

// ---- a genuine gzip+ustar tarball, mirroring podman/provision.test.ts's own fixture ----

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function tarEntry(name: string, content: Buffer): Buffer {
  const header = tarHeader(name, content.length);
  const paddingLength = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(paddingLength)]);
}

function buildFixtureTarball(): Buffer {
  const packageJson = Buffer.from(
    `${JSON.stringify({ name: "kanthord", version: "27.8.1" })}\n`,
    "utf8",
  );
  const mainTs = Buffer.from("export {};\n", "utf8");
  const tar = Buffer.concat([
    tarEntry("package/package.json", packageJson),
    tarEntry("package/src/main.ts", mainTs),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar);
}

const packedTarball = buildFixtureTarball();

// ---- a scripted daemon: tracks the settings last written, and answers the HTTP bridge ----

type DaemonState = {
  allowedHosts: readonly string[];
  tokenFileSet: boolean;
  home?: string;
  tokenValue?: string;
};

function searchOrderStderr(cwd: string, homeDirectory: string): string {
  const candidates = [
    join(cwd, "kanthord.config.json"),
    join(homeDirectory, ".config", "kanthord", "config.json"),
    join("/etc", "kanthord", "config.json"),
  ];
  return `kanthord: config-not-found: no config file found; searched: ${candidates.join(", ")}\n`;
}

function decideResponse(
  state: DaemonState,
  request: Readonly<{
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    omitHost: boolean;
  }>,
): Readonly<{ status: number; body: string }> {
  if (request.method === "POST" && request.path.endsWith("/plan/validate")) {
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ id: "task_a", suggested: "database" }],
      }),
    };
  }
  if (request.method === "POST") {
    return {
      status: 409,
      body: JSON.stringify({
        error: { code: "stale-revision", details: { current: "rev-second" } },
      }),
    };
  }
  if (request.headers.Origin !== undefined) {
    return {
      status: 403,
      body: JSON.stringify({ error: { code: "origin-forbidden" } }),
    };
  }
  const host = request.omitHost
    ? undefined
    : (request.headers.Host ?? state.allowedHosts[0]);
  if (host === undefined || !state.allowedHosts.includes(host)) {
    return {
      status: 403,
      body: JSON.stringify({ error: { code: "host-forbidden" } }),
    };
  }
  if (
    state.tokenValue === undefined ||
    request.headers.Authorization !== `Bearer ${state.tokenValue}`
  ) {
    return {
      status: 401,
      body: JSON.stringify({ error: { code: "unauthenticated" } }),
    };
  }
  if (request.method === "GET" && request.path === "/v1/status") {
    return { status: 200, body: JSON.stringify({ version: "27.8.1" }) };
  }
  return { status: 200, body: "{}" };
}

type FakeOptions = Readonly<{
  exportContent?: Readonly<Record<string, string>>;
  failPreflight?: boolean;
  aliasAlwaysOk?: boolean;
  failJourney?: boolean;
  discloseSecret?: boolean;
}>;

function buildFakes(options: FakeOptions): Readonly<{
  execute: PodmanExecutor;
  executeHost: PodmanExecutor;
  calls: (readonly string[])[];
  stdins: (string | undefined)[];
}> {
  const calls: (readonly string[])[] = [];
  const stdins: (string | undefined)[] = [];
  const state: DaemonState = { allowedHosts: [], tokenFileSet: true };
  let planImportCalls = 0;

  function dispatchCli(argv: readonly string[]): CommandRecord {
    const raw = argv.slice(argv.indexOf("kanthordc") + 1);
    const globalFlags = new Set(["--base-url", "--api-token-file", "--token"]);
    const sub: string[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      if (globalFlags.has(raw[index] as string)) {
        index += 1;
        continue;
      }
      sub.push(raw[index] as string);
    }

    if (sub[0] === "--version") {
      return record(argv, "27.8.1\n");
    }
    if (sub[0] === "credential") {
      if (options.failJourney === true) {
        return record(argv, "", 1, "kanthord: forced-failure\n");
      }
      return record(argv, "kanthord: registered fixture cred_e2e_1\n");
    }
    if (sub[0] === "repository" && sub[1] === "register") {
      return record(
        argv,
        "kanthord: registered fixture repo_e2e_1\nkanthord: upstream main\n",
      );
    }
    if (sub[0] === "repository" && sub[1] === "show") {
      return record(
        argv,
        "kanthord: landing refs/heads/main oid_a\nkanthord: tracking refs/remotes/origin/main oid_a\n",
      );
    }
    if (sub[0] === "project" && sub[1] === "create") {
      return record(
        argv,
        "kanthord: project proj_e2e_1\nkanthord: name journey\n",
      );
    }
    if (sub[0] === "project" && sub[1] === "repository") {
      return record(argv, "");
    }
    if (sub[0] === "plan" && sub[1] === "import") {
      const directory = sub[sub.indexOf("--directory") + 1] as string;
      planImportCalls += 1;
      const isReimport = planImportCalls > 1;
      mkdirSync(directory, { recursive: true });
      return record(
        argv,
        isReimport
          ? "kanthord: revision rev-second\nkanthord: task_a -> database\n"
          : "kanthord: revision rev-first\n",
      );
    }
    if (sub[0] === "plan" && sub[1] === "export") {
      const directory = sub[sub.indexOf("--directory") + 1] as string;
      // mirror the real CLI's root/plan convention (src/cli/plan/directory.ts),
      // matching the "plan/objective.md" shape cp(planRoot, ...) produces for
      // the accepted-tree snapshot.
      const planExportDirectory = join(directory, "plan");
      mkdirSync(planExportDirectory, { recursive: true });
      const content = options.exportContent ?? {
        "objective.md": "an objective\n",
      };
      for (const [path, text] of Object.entries(content)) {
        writeFileSync(join(planExportDirectory, path), text);
      }
      return record(argv, "");
    }
    if (sub[0] === "status") {
      return record(
        argv,
        "kanthord: node objective ready - 2\nkanthord: node task pending - 4\n",
      );
    }
    if (sub[0] === "run") {
      return record(
        argv,
        "",
        220,
        "kanthord: not-implemented: run is not implemented\n",
      );
    }

    throw new Error(`unexpected cli subcommand: ${sub.join(" ")}`);
  }

  const execute: PodmanExecutor = async (argv, stdin) => {
    calls.push(argv);
    stdins.push(stdin);

    if (argv[1] === "version") {
      return options.failPreflight === true
        ? record(argv, "", 1, "no such host")
        : record(argv, "6.0.0\n");
    }
    if (argv[1] === "info") {
      return record(argv, "true arm64\n");
    }
    if (
      argv.includes("--filter") &&
      argv.some((token) => token.startsWith("label="))
    ) {
      return record(argv, ""); // the six reclaim list commands
    }
    if (argv.includes("inspect") && argv.includes(baseImageReference)) {
      return record(
        argv,
        "sha256:base00000000000000000000000000000000000000000000000000000000\n",
      );
    }
    if (argv.includes("build")) {
      return record(argv, "");
    }
    if (
      argv.includes("inspect") &&
      argv.some((token) => token.includes("kanthord-e2e-product"))
    ) {
      const format = argv[argv.indexOf("--format") + 1];
      return record(
        argv,
        format === "{{.Architecture}}"
          ? "arm64\n"
          : "sha256:product00000000000000000000000000000000000000000000000000\n",
      );
    }
    if (
      argv.includes("inspect") &&
      argv.some((token) => token.includes("kanthord-e2e-fixture"))
    ) {
      return record(
        argv,
        "sha256:fixture00000000000000000000000000000000000000000000000000\n",
      );
    }
    if (argv[1] === "secret" && argv[2] === "create") {
      const secretName = argv.find((token) =>
        token.startsWith("kanthord-token-"),
      );
      if (secretName !== undefined) {
        const tokenFile = argv[argv.length - 1] as string;
        state.tokenValue = readFileSync(tokenFile, "utf8");
      }
      return record(argv, "");
    }
    if (
      argv[1] === "network" ||
      argv[1] === "volume" ||
      argv[1] === "pod" ||
      argv[1] === "secret"
    ) {
      return record(argv, "");
    }
    if (argv[1] === "run") {
      return record(argv, "");
    }
    if (
      argv[1] === "exec" &&
      argv.some((token) => token.includes("write-config.mjs"))
    ) {
      const payload = JSON.parse(stdin as string) as Readonly<{
        home: string;
        http: Readonly<{ tokenFile: string; allowedHosts: readonly string[] }>;
      }>;
      state.home = payload.home;
      state.allowedHosts = payload.http.allowedHosts;
      state.tokenFileSet = payload.http.tokenFile.length > 0;
      return record(argv, "");
    }
    if (argv[1] === "exec" && argv.includes("db") && argv.includes("migrate")) {
      return record(argv, "");
    }
    if (
      argv[1] === "exec" &&
      argv.includes("kanthord") &&
      argv.includes("serve")
    ) {
      const detached = argv.includes("--detach");
      if (!state.tokenFileSet) {
        return record(
          argv,
          "",
          1,
          "kanthord: config-refused: a non-loopback bind address requires http.token\n",
        );
      }
      if (!detached) {
        return record(
          argv,
          "",
          1,
          searchOrderStderr(daemonHomeMountPath, "/root"),
        );
      }
      return record(argv, "");
    }
    if (argv[1] === "exec" && argv.includes("pkill")) {
      return record(argv, "");
    }
    if (argv[1] === "exec" && argv.includes("rm") && argv.includes("-f")) {
      return record(argv, "");
    }
    if (
      argv[1] === "exec" &&
      argv.includes("install") &&
      argv.includes(tokenMountPath)
    ) {
      return record(argv, "");
    }
    if (
      argv[1] === "exec" &&
      argv.includes("sh") &&
      argv.some((token) => token === `cat > ${tokenMountPath}`)
    ) {
      state.tokenValue = stdin;
      return record(argv, "");
    }
    if (
      argv[1] === "exec" &&
      argv.some((token) => token.includes("e2e-request.mjs"))
    ) {
      const payload = JSON.parse(stdin as string) as Readonly<{
        method: string;
        path: string;
        headers: Readonly<Record<string, string>>;
        omitHost: boolean;
      }>;
      const response =
        options.aliasAlwaysOk === true
          ? { status: 200, body: "{}" }
          : decideResponse(state, payload);
      return record(argv, `${String(response.status)}\n${response.body}`);
    }
    if (argv[1] === "exec" && argv.includes("kanthordc")) {
      return dispatchCli(argv);
    }
    if (argv[1] === "logs") {
      return options.discloseSecret === true
        ? record(argv, `leaked: ${state.tokenValue ?? ""}\n`)
        : record(argv, "");
    }
    if (argv[0] === "podman" && argv[1] === "inspect") {
      return record(argv, "[]");
    }
    if (argv[1] === "exec" && argv.includes("cat")) {
      return record(
        argv,
        JSON.stringify({ http: { tokenFile: "/run/secrets/kanthord-token" } }),
      );
    }
    if (argv[1] === "exec" && argv.includes("stat")) {
      return record(argv, "600\n");
    }
    if (argv[0] === "podman" && argv[1] === "cp") {
      const [, , from, to] = argv;
      const colonIndex = (from as string).indexOf(":");
      const sourcePath =
        colonIndex === -1
          ? (from as string)
          : (from as string).slice(colonIndex + 1);
      cpSync(sourcePath, to as string, { recursive: true });
      return record(argv, "");
    }

    throw new Error(`unexpected podman argv: ${argv.join(" ")}`);
  };

  const executeHost: PodmanExecutor = async (argv) => {
    if (argv[0] !== "npm") {
      throw new Error(`unexpected host argv: ${argv.join(" ")}`);
    }
    if (argv[1] === "pack") {
      const destination = argv[
        argv.indexOf("--pack-destination") + 1
      ] as string;
      mkdirSync(destination, { recursive: true });
      const filename = "kanthord-27.8.1.tgz";
      writeFileSync(join(destination, filename), packedTarball);
      return record(argv, `${filename}\n`);
    }
    if (argv[1] === "ci") {
      return record(argv, "");
    }
    throw new Error(`unexpected npm argv: ${argv.join(" ")}`);
  };

  return { execute, executeHost, calls, stdins };
}

function buildContext(
  onAssertionFailure?: (error: unknown) => void,
): ScenarioContext & {
  logs(): Readonly<Record<string, string>>;
  printedLines(): readonly string[];
  commandsRecorded(): readonly CommandRecord[];
  noteHost(name: string, identity: BundleIdentity): void;
  note(key: string, value: string): void;
  setVersions(partial: Partial<BundleVersions>): void;
} & {
  assertionNames(): readonly string[];
  hosts(): Readonly<Record<string, BundleIdentity>>;
  takenResources(): readonly ResourceHandle[];
  releaseAll(): ReturnType<ReturnType<typeof createLedger>["releaseAll"]>;
} {
  const ledger = createLedger();
  const assertionNames: string[] = [];
  const printedLines: string[] = [];
  const commandsRecorded: CommandRecord[] = [];
  const logs: Record<string, string> = {};
  const hosts: Record<string, BundleIdentity> = {};

  return {
    tag: runId,
    scenarioId: "P1-E4",
    bundleDirectory: "/tmp/p1e4-test-bundle",
    take: ledger.take,
    sink: {
      print(line: string): void {
        printedLines.push(line);
      },
      record(entry: CommandRecord): void {
        commandsRecorded.push(entry);
      },
    },
    assert(name: string, expected: unknown, actual: unknown): void {
      let passed = true;
      try {
        assert.deepEqual(actual, expected);
      } catch {
        passed = false;
      }
      assertionNames.push(name);
      if (!passed) {
        const error = new RunnerError("assertion-failed", name);
        onAssertionFailure?.(error);
        throw error;
      }
    },
    noteObject(): void {},
    attachLog(name: string, text: string): void {
      logs[name] = text;
    },
    noteHost(name: string, identity: BundleIdentity): void {
      hosts[name] = identity;
    },
    note(): void {},
    setVersions(): void {},
    daemonHost: null,
    clientHost: null,
    logs(): Readonly<Record<string, string>> {
      return logs;
    },
    printedLines(): readonly string[] {
      return printedLines;
    },
    commandsRecorded(): readonly CommandRecord[] {
      return commandsRecorded;
    },
    assertionNames(): readonly string[] {
      return assertionNames;
    },
    hosts(): Readonly<Record<string, BundleIdentity>> {
      return hosts;
    },
    takenResources(): readonly ResourceHandle[] {
      return ledger.taken();
    },
    releaseAll(): ReturnType<ReturnType<typeof createLedger>["releaseAll"]> {
      return ledger.releaseAll();
    },
  };
}

const expectedAssertionOrder = [
  "startup-refusal-exit",
  "startup-refusal-message",
  "alias-omitted-status",
  "alias-omitted-code",
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
  "no-token-status",
  "no-token-code",
  "wrong-token-status",
  "wrong-token-code",
  "origin-header-status",
  "origin-header-code",
  "foreign-host-status",
  "foreign-host-code",
  "absent-host-status",
  "absent-host-code",
  "allowed-host-status",
  "no-disclosure-bearer-header",
  "no-disclosure-basic-header",
  "no-disclosure-config",
  "no-disclosure-printed-commands",
  "no-disclosure-daemon-logs",
  "no-disclosure-podman-inspect",
  "no-disclosure-diagnostics",
  "no-disclosure-config-mode",
];

test("run executes the eleven phases in order and records the exact forty assertion names", async (t) => {
  const context = buildContext();
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);
  const fakes = buildFakes({});

  await runP1E4(context, fakes.execute, fakes.executeHost, profile);

  assert.deepEqual(context.assertionNames(), expectedAssertionOrder);
  assert.equal(context.assertionNames().length, 40);

  const preflightIndex = fakes.calls.findIndex((argv) => argv[1] === "version");
  const reclaimIndex = fakes.calls.findIndex(
    (argv) =>
      argv.includes("--filter") &&
      argv.some((token) => token.startsWith("label=")),
  );
  const networkCreateIndex = fakes.calls.findIndex(
    (argv) => argv[1] === "network" && argv[2] === "create",
  );
  assert.ok(preflightIndex !== -1 && preflightIndex < reclaimIndex);
  assert.ok(reclaimIndex < networkCreateIndex);

  const writeConfigPayloads = fakes.calls
    .map((argv, index) => ({ argv, index }))
    .filter(({ argv }) =>
      argv.some((token) => token.includes("write-config.mjs")),
    )
    .map(
      ({ index }) =>
        JSON.parse(fakes.stdins[index] as string) as Readonly<{
          http: Readonly<{ allowedHosts: readonly string[] }>;
        }>,
    );
  assert.deepEqual(writeConfigPayloads[0]?.http.allowedHosts, [
    "127.0.0.1:7421",
  ]);
  const journeyStartPayload = writeConfigPayloads.find(
    (payload) => payload.http.allowedHosts[0] === topology.allowedHost,
  );
  assert.deepEqual(journeyStartPayload?.http.allowedHosts, [
    topology.allowedHost,
  ]);

  const requestPayloads = fakes.calls
    .map((argv, index) => ({ argv, index }))
    .filter(({ argv }) =>
      argv.some((token) => token.includes("e2e-request.mjs")),
    )
    .map(
      ({ index }) =>
        JSON.parse(fakes.stdins[index] as string) as Readonly<{
          method: string;
          path: string;
        }>,
    );
  // /v1/health is startDaemon's own readiness poll (Phase 7's localHandle and Phase 8's
  // journey daemon), not a transport-oracle probe — excluded so this count isolates the
  // journey's own version-parity probe, the alias-omitted probe, and the six
  // transportCases, all of which target /v1/status.
  const transportRequests = requestPayloads.filter(
    (payload) => payload.method === "GET" && payload.path === "/v1/status",
  );
  assert.equal(transportRequests.length, 8); // version-parity + alias-omitted probe + six transportCases

  const secretForms = secrets.forms();
  assert.notEqual(
    secretForms.length,
    0,
    "the secret registry must be non-empty before the disclosure sweep, or the sweep below would pass vacuously",
  );
  for (const argv of fakes.calls) {
    for (const token of argv) {
      assert.equal(
        secretForms.some((form) => token.includes(form)),
        false,
        `argv token ${token} discloses a held secret`,
      );
    }
  }

  assert.deepEqual(Object.keys(context.hosts()).sort(), ["client", "daemon"]);

  const imageHandles = context
    .takenResources()
    .filter((handle) => handle.kind === "image");
  assert.deepEqual(
    imageHandles.map((handle) => handle.id).sort(),
    [
      "sha256:fixture00000000000000000000000000000000000000000000000000",
      "sha256:product00000000000000000000000000000000000000000000000000",
    ].sort(),
  );
});

test("a fake issuer answering 200 in phase 7 makes run reject naming alias-omitted-status", async (t) => {
  const context = buildContext();
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);
  const fakes = buildFakes({ aliasAlwaysOk: true });

  await assert.rejects(
    runP1E4(context, fakes.execute, fakes.executeHost, profile),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === "assertion-failed" &&
      error.message === "alias-omitted-status",
  );
});

test("a preflight failure makes run reject with unavailable, and issues no network create, build or run command", async (t) => {
  const context = buildContext();
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);
  const fakes = buildFakes({ failPreflight: true });

  await assert.rejects(
    runP1E4(context, fakes.execute, fakes.executeHost, profile),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "unavailable",
  );

  assert.equal(
    fakes.calls.some((argv) => argv[1] === "network" && argv[2] === "create"),
    false,
  );
  assert.equal(
    fakes.calls.some((argv) => argv.includes("build")),
    false,
  );
  assert.equal(
    fakes.calls.some((argv) => argv[1] === "run"),
    false,
  );
});

test("a stale resource surviving reclaim makes run fail closed before it creates anything", async (t) => {
  const context = buildContext();
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);

  const staleId = "vol-stale-1";
  const calls: (readonly string[])[] = [];
  const execute: PodmanExecutor = async (argv) => {
    calls.push(argv);
    if (argv[1] === "version") {
      return record(argv, "6.0.0\n");
    }
    if (argv[1] === "info") {
      return record(argv, "true arm64\n");
    }
    if (argv[1] === "volume" && (argv[2] === "ls" || argv[2] === "rm")) {
      return record(argv, `${staleId}\n`);
    }
    if (
      argv.includes("--filter") &&
      argv.some((token) => token.startsWith("label="))
    ) {
      return record(argv, "");
    }
    throw new Error(
      `unexpected podman argv during a fail-closed reclaim: ${argv.join(" ")}`,
    );
  };
  const executeHost: PodmanExecutor = async (argv) => {
    throw new Error(
      `unexpected host argv during a fail-closed reclaim: ${argv.join(" ")}`,
    );
  };

  await assert.rejects(
    runP1E4(context, execute, executeHost, profile),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "assertion-failed");
      assert.match(error.message, /volume/);
      assert.match(error.message, new RegExp(staleId));
      return true;
    },
  );

  assert.equal(
    calls.some((argv) => argv[1] === "run"),
    false,
  );
});

test("a fake run that fails in phase 8 still executes phase 11 (disclosure)", async (t) => {
  const context = buildContext();
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);
  const fakes = buildFakes({ failJourney: true });

  await assert.rejects(
    runP1E4(context, fakes.execute, fakes.executeHost, profile),
  );

  assert.ok(
    context.assertionNames().some((name) => name.startsWith("no-disclosure-")),
    "disclosure assertions must run even though phase 8 failed",
  );
});

test("run takes the two images provisionImages built into the ledger even on a failing run", async (t) => {
  const context = buildContext();
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);
  // aliasAlwaysOk rejects at phase 7 (alias-omitted-status), well before phase 8 ever
  // starts the daemon — provisioning (phase 3) has already run by then.
  const fakes = buildFakes({ aliasAlwaysOk: true });

  await assert.rejects(
    runP1E4(context, fakes.execute, fakes.executeHost, profile),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === "assertion-failed" &&
      error.message === "alias-omitted-status",
  );

  const imageHandles = context
    .takenResources()
    .filter((handle) => handle.kind === "image");
  assert.deepEqual(
    imageHandles.map((handle) => handle.id).sort(),
    [
      "sha256:fixture00000000000000000000000000000000000000000000000000",
      "sha256:product00000000000000000000000000000000000000000000000000",
    ].sort(),
  );
});

test("p1-e4.ts contains no release( at all — the two image handles are taken through takeImage", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "p1-e4.ts"),
    "utf8",
  );

  assert.equal(source.includes("release("), false);
});

test("a fake run that fails in phase 8 and also discloses a secret rejects with the phase-8 error object itself, carrying disclosureFailure", async (t) => {
  let capturedThrown: unknown;
  const context = buildContext((error) => {
    if (capturedThrown === undefined) {
      capturedThrown = error;
    }
  });
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);
  const fakes = buildFakes({ failJourney: true, discloseSecret: true });

  let caught: unknown;
  try {
    await runP1E4(context, fakes.execute, fakes.executeHost, profile);
    assert.fail("expected runP1E4 to reject");
  } catch (error) {
    caught = error;
  }

  assert.ok(
    capturedThrown !== undefined,
    "expected phase 8 to fail an assertion first",
  );
  assert.equal(caught, capturedThrown);
  const disclosureFailure = (caught as { disclosureFailure?: Error })
    .disclosureFailure;
  assert.ok(disclosureFailure instanceof Error);
  assert.equal(disclosureFailure.message, "no-disclosure-basic-header");
});

test("a fake run that succeeds through phase 10 and discloses a secret rejects with the disclosure error, carrying no disclosureFailure", async (t) => {
  const context = buildContext();
  t.after(() => context.releaseAll());
  const workDir = mkdtempSync(join(tmpdir(), "kanthord-e2e-p1e4-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const profile = buildProfile(workDir);
  const fakes = buildFakes({ discloseSecret: true });

  let caught: unknown;
  try {
    await runP1E4(context, fakes.execute, fakes.executeHost, profile);
    assert.fail("expected runP1E4 to reject");
  } catch (error) {
    caught = error;
  }

  assert.ok(
    context.assertionNames().filter((name) => name.startsWith("no-disclosure-"))
      .length > 0,
    "phase 11 must have run at least one disclosure assertion",
  );
  assert.ok(caught instanceof RunnerError);
  assert.equal((caught as RunnerError).code, "assertion-failed");
  assert.equal((caught as RunnerError).message, "no-disclosure-basic-header");
  assert.equal(
    (caught as { disclosureFailure?: unknown }).disclosureFailure,
    undefined,
  );
});
