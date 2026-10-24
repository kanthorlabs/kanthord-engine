import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { temporary } from "../../kernel/test-support.ts";
import { ContainerRuntime } from "../../worker/contract.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import type { SlotEnvironment } from "../../project/contract.ts";
import {
  BASE_SUFFIX,
  UNCHECKED_SUFFIX,
  EnvironmentFailureClass,
  ImageBuildOutcome,
  environmentPath,
  environmentTagOf,
  type ImageBuildInput,
  type ImageBuildResult,
} from "../../project/environment-state.ts";
import {
  OWNER_LABEL,
  type RuntimeAnswer,
  type RuntimeHost,
} from "./container-runtime.ts";
import {
  devcontainerBuildArguments,
  EnvironmentImageFailure,
  EnvironmentImages,
  environmentDigest,
  imageSettings,
  layerContainerfile,
} from "./environment-image.ts";

const OWNER = "OWNER";
const KANTHORD_IMAGE = "localhost/kanthord-dev-node:1.0.0";
const VERSION = "1.0.0";
const KANTHORD_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const INSPECT = "inspect";
const EXISTS = "exists";
const PASSING_CLI = "process.exit(0)";
const NOT_FOUND = -1;
const PODMAN_LINE = "podman";
const BUILD_COMMAND = "build";
const RUN_COMMAND = "run";
const TAG_COMMAND = "tag";
const IDENTITY = "repository:github:Acme/.Todo_App";
const SUCCESS = 0;
const ABSENT = 1;
const FAILED_CLI = "process.exit(3)";
const HEADER_LINES = 3;
const ONE_BUILD = 1;
const WAIT_ROUNDS = 100;
const WAIT_STEP_MS = 50;
const SHORT_TIMEOUT_MS = 5000;
const BUILD_TIMEOUT_MS = 1800000;
const MEMORY_MB = 4096;
const BOUNDED_MEMORY_MB = 8192;
const MEMORY_FLAG = "--memory";
const BOUNDED_MEMORY_ARGUMENT = `${BOUNDED_MEMORY_MB}m`;
const START_WAIT_ROUNDS = 1200;

function environment(
  document: SlotEnvironment["document"] = {
    image: "mcr.microsoft.com/devcontainers/python:3.12",
  },
): SlotEnvironment {
  return {
    binding_id: "binding",
    resource_identity: IDENTITY,
    source: EnvironmentSource.Stored,
    commit: "c".repeat(40),
    document,
    files: [],
    trees: [],
  };
}

function images(
  directory: string,
  options: {
    environment: SlotEnvironment | null;
    exists: number;
    cli?: string;
    variables?: NodeJS.ProcessEnv;
    checkout?: (target: string) => void;
    inspect?: unknown;
    buildTimeoutMs?: number;
    memoryMb?: number;
    secrets?: ReadonlyArray<{ variable: string; file: string }>;
  },
) {
  const calls: string[][] = [];
  const log = join(directory, "log");
  const exports: string[] = [];
  const host: RuntimeHost = {
    platform: "linux",
    uid: 1000,
    user: "user",
    environment: options.variables ?? process.env,
    exists: () => false,
    resolves: () => true,
    run: (_runtime, args) => {
      calls.push([...args]);
      appendFileSync(log, `${JSON.stringify(["host", ...args])}\n`);
      if (args[1] === INSPECT)
        return Promise.resolve(
          args.includes("--format")
            ? { code: SUCCESS, stdout: `${KANTHORD_IMAGE_ID}\n`, stderr: "" }
            : {
                code: SUCCESS,
                stdout: JSON.stringify(
                  options.inspect ?? [{ Config: { Env: [], Labels: null } }],
                ),
                stderr: "",
              },
        );
      return Promise.resolve({
        code: args[1] === EXISTS ? options.exists : SUCCESS,
        stdout: "",
        stderr: "",
      });
    },
  };
  const cli = join(directory, "cli.mjs");
  writeFileSync(cli, options.cli ?? FAILED_CLI);
  const built = new EnvironmentImages({
    host,
    owner: OWNER,
    kanthordImage: KANTHORD_IMAGE,
    version: VERSION,
    stateDirectory: directory,
    exportRepository: (_binding, _commit, target) => {
      assert.equal(existsSync(target), true);
      exports.push(target);
      options.checkout?.(target);
      return Promise.resolve();
    },
    devcontainerCli: () => cli,
    buildTimeoutMs: options.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
    environmentMemoryMb: options.memoryMb ?? MEMORY_MB,
  });
  const lines = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
  const build = () =>
    built.build(
      {
        run_id: RUN_ID,
        binding_id: "binding",
        resource_identity: IDENTITY,
        commit: "c".repeat(40),
        tag: TAG,
        document: (options.environment ?? environment()).document,
        secrets: options.secrets ?? [],
      },
      NEVER_ABORTED,
    );
  return { built, build, calls, exports, lines };
}

function fakePodman(directory: string, codes: { build: number; run: number }) {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const log = join(directory, "log");
  writeFileSync(
    join(bin, "podman"),
    `#!/bin/sh
"${process.execPath}" -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(["podman", ...process.argv.slice(2)]) + "\\n")' "${log}" "$@"
case "$1" in
  build) exit ${codes.build} ;;
  run) exit ${codes.run} ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME };
}

test("the environment digest changes with the document, the files, the kanthord image and the version", () => {
  const first = environmentDigest(environment(), KANTHORD_IMAGE, VERSION);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(
    environmentDigest(environment(), KANTHORD_IMAGE, VERSION),
    first,
  );
  for (const other of [
    environmentDigest(environment({ image: "other" }), KANTHORD_IMAGE, VERSION),
    environmentDigest(
      {
        ...environment(),
        files: [{ path: "Dockerfile", state: "present", text: "FROM x" }],
      },
      KANTHORD_IMAGE,
      VERSION,
    ),
    environmentDigest(
      { ...environment(), trees: [{ path: ".", object: "d".repeat(40) }] },
      KANTHORD_IMAGE,
      VERSION,
    ),
    environmentDigest(environment(), "other", VERSION),
    environmentDigest(environment(), KANTHORD_IMAGE, "2.0.0"),
  ])
    assert.notEqual(other, first);
});

test("the build arguments name the runtime, the server config path, the base tag and the owner label", () => {
  assert.deepEqual(
    devcontainerBuildArguments({
      cli: "/cli/devcontainer.js",
      runtime: ContainerRuntime.Podman,
      workspace: "/state/config",
      config: "/state/config/.devcontainer/devcontainer.json",
      image: `tag${BASE_SUFFIX}`,
      owner: OWNER,
    }),
    [
      "/cli/devcontainer.js",
      "build",
      "--docker-path",
      "podman",
      "--workspace-folder",
      "/state/config",
      "--config",
      "/state/config/.devcontainer/devcontainer.json",
      "--image-name",
      "tag-base",
      "--label",
      `${OWNER_LABEL}=${OWNER}`,
    ],
  );
});

test("the image settings resolve the container variables and keep the create commands in metadata order", () => {
  const inspected = JSON.stringify([
    {
      Config: {
        Env: ["PATH=/usr/bin:/bin", "LANG=C.UTF-8"],
        Labels: {
          "devcontainer.metadata": JSON.stringify([
            {
              id: "feature",
              containerEnv: { PATH: "/feature/bin:${containerEnv:PATH}" },
              onCreateCommand: "feature-create",
            },
            {
              remoteEnv: {
                PATH: "${containerEnv:PATH}:/extra",
                HOMELESS: "${localEnv:HOME}",
                FALLBACK: "${containerEnv:ABSENT:default}",
                DROPPED: null,
              },
              onCreateCommand: { first: "one", second: ["two", "it's"] },
            },
          ]),
        },
      },
    },
  ]);
  const settings = imageSettings(inspected);
  assert.deepEqual(Object.fromEntries(settings.environment), {
    PATH: "/feature/bin:/usr/bin:/bin:/extra",
    HOMELESS: "",
    FALLBACK: "default",
  });
  assert.deepEqual(settings.onCreate, [
    "feature-create",
    "one",
    "'two' 'it'\\''s'",
  ]);
  assert.deepEqual(
    imageSettings(JSON.stringify([{ Config: { Env: null, Labels: null } }])),
    { environment: new Map(), onCreate: [] },
  );
});

test("the layer copies kanthord and tini, adds uid 10001, writes the variables and runs each create command as root", () => {
  const text = layerContainerfile({
    base: "tag-base",
    kanthordImage: KANTHORD_IMAGE,
    environment: new Map([["PATH", "/a:$HOME/b"]]),
    onCreate: ["apt-get install -y libpq-dev"],
    owner: OWNER,
    secrets: [],
    flake: false,
  });
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, HEADER_LINES), [
    `FROM ${KANTHORD_IMAGE} AS kanthord`,
    "FROM tag-base",
    "USER root",
  ]);
  assert.ok(
    lines.includes(
      "COPY --from=kanthord /usr/local/bin/kanthord /usr/local/bin/kanthord",
    ),
  );
  assert.ok(
    lines.includes("COPY --from=kanthord /usr/bin/tini-static /usr/bin/tini"),
  );
  assert.ok(lines.some((line) => line.includes("10001::/var/lib/kanthord")));
  assert.ok(lines.includes('ENV PATH="/a:\\$HOME/b"'));
  assert.ok(
    lines.includes('RUN ["/bin/sh","-c","apt-get install -y libpq-dev"]'),
  );
  assert.ok(lines.indexOf("USER 10001") > lines.indexOf("USER root"));
  assert.ok(lines.includes(`LABEL ${OWNER_LABEL}="${OWNER}"`));
});

const REPORT_CLI = `import { existsSync, readFileSync } from "node:fs";
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const config = value("--config");
process.stderr.write(JSON.stringify({
  config,
  workspace: value("--workspace-folder"),
  document: JSON.parse(readFileSync(config, "utf8")),
  feature: existsSync(config.replace("devcontainer.json", "local/install.sh")),
  variables: Object.keys(process.env),
  values: Object.values(process.env),
}));
process.exit(3);`;

function reportOf(result: ImageBuildResult): {
  config: string;
  workspace: string;
  document: Record<string, unknown>;
  feature: boolean;
  variables: string[];
  values: string[];
} {
  assert.ok(result.outcome === ImageBuildOutcome.Failed);
  return JSON.parse(result.tail);
}

function failureOf(result: ImageBuildResult): {
  class: string;
  detail: string;
} {
  assert.ok(result.outcome === ImageBuildOutcome.Failed);
  return { class: result.class, detail: result.tail };
}

function writeCheckout(target: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), text);
  }
}

test("the build writes the allowlisted document outside the checkout with absolute build paths", async (t) => {
  const directory = temporary(t);
  let checkout = "";
  const { build } = images(directory, {
    environment: environment({
      name: "dev",
      customizations: { kanthord: { checks: ["node --version"] } },
      build: { dockerfile: "Dockerfile", context: ".." },
      features: { "./local": {} },
      postCreateCommand: "npm ci",
    }),
    exists: ABSENT,
    cli: REPORT_CLI,
    checkout: (target) => {
      checkout = realpathSync(target);
      writeCheckout(target, {
        ".devcontainer/Dockerfile": "FROM scratch",
        ".devcontainer/local/install.sh": "true",
      });
    },
  });
  const report = reportOf(await build());
  assert.equal(report.config.startsWith(checkout), false);
  assert.equal(report.workspace.startsWith(checkout), false);
  assert.deepEqual(report.document, {
    build: {
      dockerfile: join(checkout, ".devcontainer", "Dockerfile"),
      context: checkout,
    },
    features: { "./local": {} },
    postCreateCommand: "npm ci",
  });
  assert.equal(report.feature, true);
});

test("the build gives the devcontainer CLI no server variable", async (t) => {
  const { build } = images(temporary(t), {
    environment: environment(),
    exists: ABSENT,
    cli: REPORT_CLI,
    variables: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: "/xdg",
      CONTAINER_HOST: "unix:///podman.sock",
      GH_TOKEN: "s3cr3t",
      OPENROUTER_API_KEY: "s3cr3t",
    },
  });
  const report = reportOf(await build());
  const PLATFORM_VARIABLE = "__CF_";
  assert.deepEqual(
    report.variables
      .filter((name) => !name.startsWith(PLATFORM_VARIABLE))
      .sort(),
    ["CONTAINER_HOST", "HOME", "PATH", "XDG_CONFIG_HOME"],
  );
  assert.equal(report.values.includes("s3cr3t"), false);
});

test("a symlinked .devcontainer of the checkout gets no write and no build path outside the checkout", async (t) => {
  const directory = temporary(t);
  const outside = join(directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "Dockerfile"), "FROM scratch");
  const link = (target: string) =>
    symlinkSync(outside, join(target, ".devcontainer"));
  mkdirSync(join(directory, "stored"));
  const stored = images(join(directory, "stored"), {
    environment: environment(),
    exists: ABSENT,
    cli: REPORT_CLI,
    checkout: link,
  });
  reportOf(await stored.build());
  assert.deepEqual(readdirSync(outside), ["Dockerfile"]);
  mkdirSync(join(directory, "dockerfile"));
  const dockerfile = images(join(directory, "dockerfile"), {
    environment: environment({ build: { dockerfile: "Dockerfile" } }),
    exists: ABSENT,
    cli: REPORT_CLI,
    checkout: link,
  });
  assert.deepEqual(failureOf(await dockerfile.build()), {
    class: EnvironmentImageFailure.BuildFailed,
    detail: "build.dockerfile: the path leaves the checkout",
  });
});

test("a local feature with a symbolic link fails the build and names the feature", async (t) => {
  const { build } = images(temporary(t), {
    environment: environment({ image: "base", features: { "./local": {} } }),
    exists: ABSENT,
    cli: REPORT_CLI,
    checkout: (target) => {
      writeCheckout(target, { ".devcontainer/local/install.sh": "true" });
      symlinkSync("/etc/passwd", join(target, ".devcontainer/local/passwd"));
    },
  });
  assert.deepEqual(failureOf(await build()), {
    class: EnvironmentImageFailure.BuildFailed,
    detail: "features../local: the feature holds a symbolic link",
  });
});

const TAG = environmentTagOf(
  IDENTITY,
  environmentDigest(environment(), KANTHORD_IMAGE_ID, VERSION),
);
const STAGING = `${TAG}${UNCHECKED_SUFFIX}`;

function indexOf(
  lines: string[][],
  match: (line: string[]) => boolean,
): number {
  const index = lines.findIndex(match);
  assert.notEqual(index, NOT_FOUND);
  return index;
}

test("the layer gets the final tag only after the check passes", async (t) => {
  const directory = temporary(t);
  const { build, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
  });
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  const log = lines();
  assert.equal(
    log.filter((line) => line[0] === PODMAN_LINE && line[1] === BUILD_COMMAND)
      .length,
    ONE_BUILD,
  );
  const built = indexOf(
    log,
    (line) => line[1] === BUILD_COMMAND && line.includes(STAGING),
  );
  const check = indexOf(
    log,
    (line) => line[1] === RUN_COMMAND && line.includes(STAGING),
  );
  const tagged = indexOf(log, (line) =>
    line.join(" ").endsWith(`tag ${STAGING} ${TAG}`),
  );
  const untagged = indexOf(log, (line) =>
    line.join(" ").endsWith(`untag ${STAGING} ${STAGING}`),
  );
  assert.ok(built < check && check < tagged && tagged < untagged);
  assert.equal(
    log
      .slice(0, tagged)
      .some((line) => line.at(-1) === TAG && line[2] !== EXISTS),
    false,
  );
});

test("the image check runs hardened with the owner label and a failed check removes the container and the staging tag", async (t) => {
  const directory = temporary(t);
  const { build, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: ABSENT }),
  });
  const failure = failureOf(await build());
  assert.equal(failure.class, EnvironmentImageFailure.ImageInvalid);
  const log = lines();
  const check = log.find(
    (line) => line[0] === PODMAN_LINE && line[1] === RUN_COMMAND,
  );
  assert.ok(check);
  for (const flag of [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--network=none",
  ])
    assert.ok(check.includes(flag), flag);
  assert.equal(check[check.indexOf("--label") + 1], `${OWNER_LABEL}=${OWNER}`);
  const name = check[check.indexOf("--name") + 1];
  assert.match(name ?? "", /^kanthord-env-check-[0-9a-f]+$/);
  assert.ok(log.some((line) => line.join(" ") === `host rm --force ${name}`));
  assert.ok(log.some((line) => line.join(" ") === `host image rm ${STAGING}`));
  assert.equal(
    log.some((line) => line[1] === TAG_COMMAND),
    false,
  );
});

test("the layer build and the image check hold the memory bound and the devcontainer build holds none", async (t) => {
  const directory = temporary(t);
  const { build, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
    memoryMb: BOUNDED_MEMORY_MB,
  });
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  const log = lines();
  const layer = log.find(
    (line) =>
      line[0] === PODMAN_LINE &&
      line[1] === BUILD_COMMAND &&
      line.includes(STAGING),
  );
  const check = log.find(
    (line) =>
      line[0] === PODMAN_LINE &&
      line[1] === RUN_COMMAND &&
      line.includes(STAGING),
  );
  for (const call of [layer, check]) {
    assert.ok(call);
    assert.equal(call[call.indexOf(MEMORY_FLAG) + 1], BOUNDED_MEMORY_ARGUMENT);
  }
  const devcontainer = devcontainerBuildArguments({
    cli: "/cli/devcontainer.js",
    runtime: ContainerRuntime.Podman,
    workspace: "/state/workspace",
    config: "/state/config/.devcontainer/devcontainer.json",
    image: "base",
    owner: OWNER,
  });
  assert.equal(devcontainer.includes(MEMORY_FLAG), false);
});

test("a layer variable that a Containerfile line cannot hold fails the build and names the key", async (t) => {
  const directory = temporary(t);
  const { build, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
    inspect: [
      {
        Config: {
          Env: [],
          Labels: {
            "devcontainer.metadata": JSON.stringify([
              { containerEnv: { "BAD NAME": "x" } },
            ]),
          },
        },
      },
    ],
  });
  assert.deepEqual(failureOf(await build()), {
    class: EnvironmentImageFailure.BuildFailed,
    detail: "containerEnv.BAD NAME: the variable name is not valid",
  });
  assert.equal(
    lines().some((line) => line[0] === PODMAN_LINE),
    false,
  );
});

test("the layer runs each create command before kanthord, tini and the passwd entry go in", () => {
  const lines = layerContainerfile({
    base: "tag-base",
    kanthordImage: KANTHORD_IMAGE,
    environment: new Map(),
    onCreate: ["create"],
    owner: OWNER,
    secrets: [],
    flake: false,
  }).split("\n");
  const create = lines.indexOf('RUN ["/bin/sh","-c","create"]');
  assert.notEqual(create, NOT_FOUND);
  assert.ok(
    create <
      lines.indexOf(
        "COPY --from=kanthord /usr/local/bin/kanthord /usr/local/bin/kanthord",
      ),
  );
  assert.ok(
    create <
      lines.findIndex((line) => line.includes("10001::/var/lib/kanthord")),
  );
});

const CACHE_ROOT = "/var/lib/kanthord/.cache";
const CACHE_DEFAULT_LINES = [
  `ENV npm_config_cache=${CACHE_ROOT}/npm`,
  `ENV npm_config_store_dir=${CACHE_ROOT}/pnpm-store`,
  `ENV PIP_CACHE_DIR=${CACHE_ROOT}/pip`,
  `ENV GOMODCACHE=${CACHE_ROOT}/go-mod`,
  `ENV CARGO_HOME=${CACHE_ROOT}/cargo`,
];

function layerLines(environment: Map<string, string>): string[] {
  return layerContainerfile({
    base: "tag-base",
    kanthordImage: KANTHORD_IMAGE,
    environment,
    onCreate: [],
    owner: OWNER,
    secrets: [],
    flake: false,
  }).split("\n");
}

test("the layer writes the five cache defaults when the document sets no cache variable", () => {
  const lines = layerLines(new Map());
  for (const line of CACHE_DEFAULT_LINES) assert.ok(lines.includes(line), line);
});

test("the layer keeps a cache variable of the document and writes the other four defaults before the document variables", () => {
  const lines = layerLines(new Map([["CARGO_HOME", "/custom"]]));
  assert.ok(lines.includes('ENV CARGO_HOME="/custom"'));
  assert.ok(!lines.includes(`ENV CARGO_HOME=${CACHE_ROOT}/cargo`));
  for (const line of CACHE_DEFAULT_LINES.slice(0, -1))
    assert.ok(lines.includes(line), line);
  assert.ok(
    lines.indexOf(CACHE_DEFAULT_LINES[0]!) <
      lines.indexOf('ENV CARGO_HOME="/custom"'),
  );
});

test("the layer creates the cache directory for uid 10001 after the passwd step and before the USER line", () => {
  const lines = layerLines(new Map());
  const step = lines.findIndex((line) =>
    line.includes(`mkdir -p ${CACHE_ROOT} && chown 10001:10001 ${CACHE_ROOT}`),
  );
  assert.notEqual(step, NOT_FOUND);
  assert.ok(
    step > lines.findIndex((line) => line.includes("10001::/var/lib/kanthord")),
  );
  assert.ok(step < lines.indexOf("USER 10001"));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ended(pid: number): Promise<boolean> {
  for (let round = 0; round < WAIT_ROUNDS; round++) {
    if (!alive(pid)) return true;
    await delay(WAIT_STEP_MS);
  }
  return false;
}

const HANGING_CLI = (
  pidFile: string,
) => `import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
const child = spawn("sleep", ["30"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(`${pidFile}.next`)}, String(child.pid));
renameSync(${JSON.stringify(`${pidFile}.next`)}, ${JSON.stringify(pidFile)});
setInterval(() => {}, 1000);`;

async function pidOf(file: string): Promise<number> {
  for (let round = 0; round < START_WAIT_ROUNDS; round++) {
    if (existsSync(file) && readFileSync(file, "utf8"))
      return Number(readFileSync(file, "utf8"));
    await delay(WAIT_STEP_MS);
  }
  assert.fail("The build did not start.");
}

test("a build past its time limit ends the whole process group", async (t) => {
  const directory = temporary(t);
  const pidFile = join(directory, "pid");
  const { build } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: HANGING_CLI(pidFile),
    buildTimeoutMs: SHORT_TIMEOUT_MS,
  });
  const failure = failureOf(await build());
  assert.equal(failure.class, EnvironmentImageFailure.BuildFailed);
  assert.match(failure.detail, /time limit/);
  assert.equal(await ended(await pidOf(pidFile)), true);
});

test("a stop ends a running build and a start removes the run directories of an earlier run", async (t) => {
  const directory = temporary(t);
  const stale = join(directory, "environments", "run-stale");
  mkdirSync(stale, { recursive: true });
  const pidFile = join(directory, "pid");
  const { built, build } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: HANGING_CLI(pidFile),
  });
  assert.equal(existsSync(stale), false);
  const pending = build();
  const pid = await pidOf(pidFile);
  built.stop();
  await pending;
  assert.equal(await ended(pid), true);
});

const RUN_ID = "RUN1";
const TRUE_COMMAND = "true";
const PATH_OF_IDENTITY = environmentPath(IDENTITY);
const IMAGE_ROOT = `localhost/kanthord-env/${PATH_OF_IDENTITY}`;
const DIGEST = "d".repeat(64);
const REJECTED = 1;
const RECORDED_TAIL = "recorded";
const FIRST_TAG = "first";
const SECOND_TAG = "second";
const LIST_COMMAND = "ls";
const RECORDING_CLI = (
  file: string,
) => `import { appendFileSync, readFileSync } from "node:fs";
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
appendFileSync(${JSON.stringify(file)}, JSON.stringify({
  config: value("--config"),
  image: value("--image-name"),
  document: readFileSync(value("--config"), "utf8"),
}) + "\\n");
process.stderr.write("recorded");
process.exit(CODE);`;

function buildInput(): ImageBuildInput {
  return {
    run_id: RUN_ID,
    binding_id: "binding",
    resource_identity: IDENTITY,
    commit: "c".repeat(40),
    tag: TAG,
    document: environment().document,
    secrets: [],
  };
}

function runDirectory(directory: string): string {
  return join(directory, "environments", `run-${RUN_ID}`);
}

const NEVER_ABORTED = new AbortController().signal;

test("a build exports into the run directory, writes the document outside the workspace, builds the three tags and removes the run directory", async (t) => {
  const directory = temporary(t);
  const record = join(directory, "record");
  const { built, exports, lines } = images(directory, {
    environment: null,
    exists: ABSENT,
    cli: RECORDING_CLI(record).replace("CODE", "0"),
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
  });
  assert.deepEqual(await built.build(buildInput(), NEVER_ABORTED), {
    outcome: ImageBuildOutcome.Built,
  });
  assert.deepEqual(exports, [join(runDirectory(directory), "workspace")]);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), {
    config: join(runDirectory(directory), "devcontainer.json"),
    image: `${TAG}${BASE_SUFFIX}`,
    document: JSON.stringify(environment().document),
  });
  const log = lines();
  assert.ok(
    log.some(
      (line) =>
        line[0] === PODMAN_LINE &&
        line[1] === BUILD_COMMAND &&
        line.includes(STAGING),
    ),
  );
  assert.ok(
    log.some((line) => line.join(" ") === `host tag ${STAGING} ${TAG}`),
  );
  assert.equal(existsSync(runDirectory(directory)), false);
});

test("a failed devcontainer build answers build_failed with the tail and removes the run directory", async (t) => {
  const directory = temporary(t);
  const { built } = images(directory, {
    environment: null,
    exists: ABSENT,
    cli: RECORDING_CLI(join(directory, "record")).replace("CODE", "3"),
  });
  const result = await built.build(buildInput(), NEVER_ABORTED);
  assert.ok(result.outcome === ImageBuildOutcome.Failed);
  assert.equal(result.class, EnvironmentFailureClass.BuildFailed);
  assert.equal(result.tail, RECORDED_TAIL);
  assert.equal(existsSync(runDirectory(directory)), false);
});

test("a failed image check answers image_invalid, removes the staging tag and removes the run directory", async (t) => {
  const directory = temporary(t);
  const { built, lines } = images(directory, {
    environment: null,
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: ABSENT }),
  });
  const result = await built.build(buildInput(), NEVER_ABORTED);
  assert.ok(result.outcome === ImageBuildOutcome.Failed);
  assert.equal(result.class, EnvironmentFailureClass.ImageInvalid);
  assert.ok(
    lines().some((line) => line.join(" ") === `host image rm ${STAGING}`),
  );
  assert.equal(existsSync(runDirectory(directory)), false);
});

test("an aborted signal ends the build, kills its process group and removes the run directory", async (t) => {
  const directory = temporary(t);
  const pidFile = join(directory, "pid");
  const { built } = images(directory, {
    environment: null,
    exists: ABSENT,
    cli: HANGING_CLI(pidFile),
  });
  const controller = new AbortController();
  const pending = built.build(buildInput(), controller.signal);
  const pid = await pidOf(pidFile);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(await ended(pid), true);
  assert.equal(existsSync(runDirectory(directory)), false);
});

function runtimeImages(
  directory: string,
  answer: (args: readonly string[]) => Partial<RuntimeAnswer>,
) {
  const calls: string[][] = [];
  const host: RuntimeHost = {
    platform: "linux",
    uid: 1000,
    user: "user",
    environment: process.env,
    exists: () => false,
    resolves: () => true,
    run: (_runtime, args) => {
      calls.push([...args]);
      return Promise.resolve({
        code: SUCCESS,
        stdout: "",
        stderr: "",
        ...answer(args),
      });
    },
  };
  const built = new EnvironmentImages({
    host,
    owner: OWNER,
    kanthordImage: KANTHORD_IMAGE,
    version: VERSION,
    stateDirectory: directory,
    buildTimeoutMs: BUILD_TIMEOUT_MS,
    environmentMemoryMb: MEMORY_MB,
    exportRepository: () => Promise.resolve(),
  });
  return { built, calls };
}

test("imageId answers the id of the image and null for an absent image, and imageExists answers the runtime", async (t) => {
  const { built } = runtimeImages(temporary(t), (args) =>
    args.includes("present")
      ? { stdout: `${KANTHORD_IMAGE_ID}\n` }
      : { code: REJECTED },
  );
  assert.equal(
    await built.imageId("present", NEVER_ABORTED),
    KANTHORD_IMAGE_ID,
  );
  assert.equal(await built.imageId("absent", NEVER_ABORTED), null);
  assert.equal(await built.imageExists("present"), true);
  const absent = runtimeImages(temporary(t), () => ({ code: REJECTED }));
  assert.equal(await absent.built.imageExists("absent"), false);
});

test("tagProved tags the proved suffix and removeTags removes each tag past a failed removal", async (t) => {
  const { built, calls } = runtimeImages(temporary(t), (args) =>
    args.at(-1) === FIRST_TAG ? { code: REJECTED } : {},
  );
  await built.tagProved(TAG);
  await built.removeTags([FIRST_TAG, SECOND_TAG]);
  assert.deepEqual(calls, [
    ["tag", TAG, `${TAG}-proved`],
    ["image", "rm", FIRST_TAG],
    ["image", "rm", SECOND_TAG],
  ]);
});

function listing(): string {
  return [
    `${IMAGE_ROOT}:old`,
    `${IMAGE_ROOT}:${DIGEST}`,
    `${IMAGE_ROOT}:${DIGEST}-base`,
    `${IMAGE_ROOT}:${DIGEST}-proved`,
    `${IMAGE_ROOT}:${DIGEST}-unchecked`,
    `${IMAGE_ROOT}:<none>`,
    `${IMAGE_ROOT}-other:old`,
    `${IMAGE_ROOT}/child:old`,
    "",
  ].join("\n");
}

function collection(directory: string) {
  return runtimeImages(directory, (args) => {
    if (args[1] === LIST_COMMAND) return { stdout: listing() };
    return args.at(-1) === `${IMAGE_ROOT}:old` ? { code: REJECTED } : {};
  });
}

test("collect removes the owner images of the path other than the current digest, its base and its proved tag", async (t) => {
  const { built, calls } = collection(temporary(t));
  await built.collect(PATH_OF_IDENTITY, DIGEST);
  assert.deepEqual(calls[0]?.slice(0, 6), [
    "image",
    "ls",
    "--filter",
    `label=${OWNER_LABEL}=${OWNER}`,
    "--filter",
    `reference=${IMAGE_ROOT}`,
  ]);
  assert.deepEqual(calls.slice(1), [
    ["image", "rm", `${IMAGE_ROOT}:old`],
    ["image", "rm", `${IMAGE_ROOT}:${DIGEST}-unchecked`],
  ]);
});

test("collect with no digest removes every owner image of the path", async (t) => {
  const { built, calls } = collection(temporary(t));
  await built.collect(PATH_OF_IDENTITY, null);
  assert.deepEqual(
    calls.slice(1).map((call) => call.at(-1)),
    [
      `${IMAGE_ROOT}:old`,
      `${IMAGE_ROOT}:${DIGEST}`,
      `${IMAGE_ROOT}:${DIGEST}-base`,
      `${IMAGE_ROOT}:${DIGEST}-proved`,
      `${IMAGE_ROOT}:${DIGEST}-unchecked`,
    ],
  );
});

test("removeStaleRuns removes each run directory and nothing else of the environments directory", async (t) => {
  const directory = temporary(t);
  const { built } = runtimeImages(directory, () => ({}));
  const root = join(directory, "environments");
  mkdirSync(join(root, "run-a", "workspace"), { recursive: true });
  mkdirSync(join(root, "run-b"));
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "keep.txt"), "x");
  await built.removeStaleRuns();
  assert.deepEqual(readdirSync(root).sort(), ["keep.txt", "other"]);
});

test("prove runs the commands in one container of the image through the proof", async (t) => {
  const directory = temporary(t);
  const { built, lines } = images(directory, {
    environment: null,
    exists: SUCCESS,
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
    checkout: (target) => {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-C",
            target,
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            ...args,
          ],
          { stdio: "ignore" },
        );
      git("init", "--quiet");
      git("commit", "--quiet", "--allow-empty", "-m", "head");
    },
  });
  const results = await built.prove(
    {
      run_id: RUN_ID,
      project_id: "project",
      binding_id: "binding",
      resource_identity: IDENTITY,
      commit: "c".repeat(40),
      setup: [],
      checks: [TRUE_COMMAND],
      tag: TAG,
    },
    NEVER_ABORTED,
  );
  assert.deepEqual(
    results.map((result) => [result.command, result.exit_code]),
    [[TRUE_COMMAND, SUCCESS]],
  );
  assert.ok(
    lines().some(
      (line) =>
        line[0] === PODMAN_LINE &&
        line.includes("bash") &&
        line.at(-1) === TRUE_COMMAND,
    ),
  );
  assert.equal(existsSync(runDirectory(directory)), false);
});

const REGISTRY_SECRET = {
  variable: "REGISTRY_AUTH",
  file: "/state/environments/run-1/secrets/REGISTRY_AUTH",
};
const NPM_SECRET = {
  variable: "NPM_TOKEN",
  file: "/state/environments/run-1/secrets/NPM_TOKEN",
};
const PNPM_STEP = "npm install -g pnpm@9";
const CONFIG_STEP = "npm config list";
const SECRET_FLAG = "--secret";
const CREATE_STEPS = 2;

function secretMount(secret: { variable: string }): string {
  return `--mount=type=secret,id=${secret.variable}`;
}

function secretExport(secret: { variable: string }): string {
  return `export ${secret.variable}="$(cat /run/secrets/${secret.variable})"`;
}

function secretLayer(
  secrets: ReadonlyArray<{ variable: string; file: string }>,
): string[] {
  return layerContainerfile({
    base: "tag-base",
    kanthordImage: KANTHORD_IMAGE,
    environment: new Map(),
    onCreate: [PNPM_STEP, CONFIG_STEP],
    owner: OWNER,
    secrets,
    flake: false,
  }).split("\n");
}

test("a build with a secret passes the secret to the layer build", async (t) => {
  const directory = temporary(t);
  const { build, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
    secrets: [REGISTRY_SECRET],
  });
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  const layer = lines().find(
    (line) => line[0] === PODMAN_LINE && line[1] === BUILD_COMMAND,
  );
  assert.ok(layer);
  const flag = layer.indexOf(SECRET_FLAG);
  assert.notEqual(flag, NOT_FOUND);
  assert.equal(layer[flag + 1], `id=REGISTRY_AUTH,src=${REGISTRY_SECRET.file}`);
});

test("a build with no secret passes no secret argument", async (t) => {
  const directory = temporary(t);
  const { build, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
  });
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  const layer = lines().find(
    (line) => line[0] === PODMAN_LINE && line[1] === BUILD_COMMAND,
  );
  assert.ok(layer);
  assert.equal(layer.includes(SECRET_FLAG), false);
});

test("the layer mounts the secret in each create command and exports it from the secret file", () => {
  const lines = secretLayer([REGISTRY_SECRET]);
  for (const step of [PNPM_STEP, CONFIG_STEP])
    assert.ok(
      lines.includes(
        `RUN ${secretMount(REGISTRY_SECRET)} ${JSON.stringify([
          "/bin/sh",
          "-c",
          `${secretExport(REGISTRY_SECRET)}; ${step}`,
        ])}`,
      ),
      step,
    );
  assert.equal(
    lines.filter((line) => line.includes("--mount")).length,
    CREATE_STEPS,
  );
});

test("the layer mounts and exports two secrets in variable order", () => {
  const lines = secretLayer([REGISTRY_SECRET, NPM_SECRET]);
  for (const step of [PNPM_STEP, CONFIG_STEP])
    assert.ok(
      lines.includes(
        `RUN ${secretMount(NPM_SECRET)} ${secretMount(REGISTRY_SECRET)} ${JSON.stringify(
          [
            "/bin/sh",
            "-c",
            `${secretExport(NPM_SECRET)}; ${secretExport(REGISTRY_SECRET)}; ${step}`,
          ],
        )}`,
      ),
      step,
    );
});

test("the layer with no secret writes the create commands without a mount", () => {
  const lines = secretLayer([]);
  assert.ok(
    lines.includes(`RUN ${JSON.stringify(["/bin/sh", "-c", PNPM_STEP])}`),
  );
  assert.ok(
    lines.includes(`RUN ${JSON.stringify(["/bin/sh", "-c", CONFIG_STEP])}`),
  );
  assert.equal(
    lines.some(
      (line) => line.includes("--mount") || line.includes("/run/secrets"),
    ),
    false,
  );
});

test("the passwd step, the cache step and the copy steps of the layer hold no secret mount", () => {
  const lines = secretLayer([REGISTRY_SECRET]);
  const others = lines.filter(
    (line) =>
      !line.includes(PNPM_STEP) &&
      !line.includes(CONFIG_STEP) &&
      !line.startsWith("FROM"),
  );
  assert.ok(others.some((line) => line.startsWith("COPY --from=kanthord")));
  assert.ok(others.some((line) => line.includes("10001::/var/lib/kanthord")));
  assert.equal(
    others.some(
      (line) => line.includes("--mount") || line.includes("REGISTRY_AUTH"),
    ),
    false,
  );
});

test("the devcontainer build holds no secret argument, no secret path and no secret variable", async (t) => {
  const directory = temporary(t);
  const record = join(directory, "invocation");
  const { build } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));`,
    variables: {
      ...fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
      REGISTRY_AUTH: "ambient-value",
    },
    secrets: [REGISTRY_SECRET],
  });
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  const invocation = JSON.parse(readFileSync(record, "utf8")) as {
    argv: string[];
    env: Record<string, string>;
  };
  assert.equal(invocation.argv.includes(SECRET_FLAG), false);
  assert.equal(
    invocation.argv.some((argument) => argument.includes(REGISTRY_SECRET.file)),
    false,
  );
  assert.equal(Object.hasOwn(invocation.env, "REGISTRY_AUTH"), false);
});

const FLAKE_COPY = "COPY flake/ /etc/kanthord-flake/";

function snapshotPodman(directory: string, snapshot: string) {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const log = join(directory, "log");
  writeFileSync(
    join(bin, "podman"),
    `#!/bin/sh
"${process.execPath}" -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(["podman", ...process.argv.slice(2)]) + "\\n")' "${log}" "$@"
if [ "$1" = build ]; then
  for last; do :; done
  cp -R "$last" "${snapshot}"
fi
exit 0
`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME };
}

function snapshotBuild(
  directory: string,
  files: Record<string, string>,
  extra?: (target: string) => void,
) {
  const snapshot = join(directory, "snapshot");
  return {
    snapshot,
    ...images(directory, {
      environment: environment({
        image: "base",
        onCreateCommand: "nix print-dev-env",
      }),
      exists: ABSENT,
      cli: PASSING_CLI,
      variables: snapshotPodman(directory, snapshot),
      checkout: (target) => {
        writeCheckout(target, files);
        extra?.(target);
      },
      inspect: [
        {
          Config: {
            Env: [],
            Labels: {
              "devcontainer.metadata": JSON.stringify([
                { onCreateCommand: "nix print-dev-env" },
              ]),
            },
          },
        },
      ],
    }),
  };
}

test("a build with flake.nix copies the workspace without .git into the layer before the create commands", async (t) => {
  const directory = temporary(t);
  const { build, snapshot } = snapshotBuild(directory, {
    "flake.nix": "{}",
    "flake.lock": "{}",
    "nix/shell.nix": "{}",
    ".git/HEAD": "ref",
  });
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  const copied = join(snapshot, "flake");
  assert.deepEqual(
    readdirSync(copied, { recursive: true }).map(String).sort(),
    ["flake.lock", "flake.nix", "nix", "nix/shell.nix"],
  );
  const lines = readFileSync(join(snapshot, "Containerfile"), "utf8").split(
    "\n",
  );
  const copy = lines.indexOf(FLAKE_COPY);
  assert.ok(copy > lines.indexOf("WORKDIR /"));
  assert.ok(copy < lines.indexOf('RUN ["/bin/sh","-c","nix print-dev-env"]'));
  assert.equal(existsSync(runDirectory(directory)), false);
});

test("a workspace link that leaves the workspace refuses the flake build and names the link", async (t) => {
  const directory = temporary(t);
  const { build } = snapshotBuild(directory, { "flake.nix": "{}" }, (target) =>
    symlinkSync("/etc/passwd", join(target, "passwd-link")),
  );
  const failure = failureOf(await build());
  assert.equal(failure.class, EnvironmentImageFailure.BuildFailed);
  assert.ok(failure.detail.includes("passwd-link"));
});

test("a workspace link that stays inside the workspace is copied as a link", async (t) => {
  const directory = temporary(t);
  const { build, snapshot } = snapshotBuild(
    directory,
    { "flake.nix": "{}", "nix/shell.nix": "{}" },
    (target) => symlinkSync("nix/shell.nix", join(target, "shell-link")),
  );
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  assert.deepEqual(
    [readlinkSync(join(snapshot, "flake", "shell-link"))],
    ["nix/shell.nix"],
  );
});

test("a build without flake.nix writes no flake copy and no flake directory", async (t) => {
  const directory = temporary(t);
  const { build, snapshot } = snapshotBuild(directory, {
    "package.json": "{}",
    ".git/HEAD": "ref",
  });
  assert.deepEqual(await build(), { outcome: ImageBuildOutcome.Built });
  assert.equal(existsSync(join(snapshot, "flake")), false);
  const text = readFileSync(join(snapshot, "Containerfile"), "utf8");
  assert.equal(text.includes("/etc/kanthord-flake/"), false);
});
