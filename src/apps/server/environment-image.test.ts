import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { temporary } from "../../kernel/test-support.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import type { SlotEnvironment } from "../../project/contract.ts";
import {
  ContainerRuntime,
  PoolPlacement,
  type PoolSlot,
} from "../../worker/contract.ts";
import { OWNER_LABEL, type RuntimeHost } from "./container-runtime.ts";
import {
  BASE_TAG_SUFFIX,
  devcontainerBuildArguments,
  ENVIRONMENT_IMAGE_FAILED,
  FAILURE_HOLD_MS,
  IMAGE_NAME_MAX_LENGTH,
  STAGING_TAG_SUFFIX,
  EnvironmentImageFailure,
  EnvironmentImages,
  environmentDigest,
  environmentTag,
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
const HOST_LINE = "host";
const PODMAN_LINE = "podman";
const BUILD_COMMAND = "build";
const RUN_COMMAND = "run";
const TAG_COMMAND = "tag";
const SUM = "a".repeat(64);
const IDENTITY = "repository:github:Acme/.Todo_App";
const SUCCESS = 0;
const ABSENT = 1;
const FAILED_CLI = "process.exit(3)";
const HEADER_LINES = 3;
const ONE_BUILD = 1;
const WAIT_ROUNDS = 100;
const WAIT_STEP_MS = 50;
const SHORT_TIMEOUT_MS = 1000;

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

const slot: PoolSlot = {
  project_id: "project",
  resource_identity: "worker:coder",
  generation: 1,
  placement: PoolPlacement.Container,
  slot: 0,
  client_id: "client",
  draining: false,
};

function images(
  directory: string,
  options: {
    environment: SlotEnvironment | null;
    exists: number;
    cli?: string;
    variables?: NodeJS.ProcessEnv;
    checkout?: (target: string) => void;
    inspect?: unknown;
    now?: () => number;
    buildTimeoutMs?: number;
    slotEnvironment?: () => Promise<SlotEnvironment | null>;
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
    fallbackImage: KANTHORD_IMAGE,
    slotEnvironment:
      options.slotEnvironment ?? (() => Promise.resolve(options.environment)),
    exportRepository: (_binding, _commit, target) => {
      assert.equal(existsSync(target), true);
      exports.push(target);
      options.checkout?.(target);
      return Promise.resolve();
    },
    devcontainerCli: () => cli,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.buildTimeoutMs === undefined
      ? {}
      : { buildTimeoutMs: options.buildTimeoutMs }),
  });
  const lines = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
  return { built, calls, exports, lines };
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

test("an environment tag keeps a valid image path for every resource identity", () => {
  assert.equal(
    environmentTag(IDENTITY, SUM),
    `localhost/kanthord-env/repository/github/acme/todo-app:${SUM}`,
  );
  assert.equal(
    environmentTag("repository:gitlab:Group/Sub/__", SUM),
    `localhost/kanthord-env/repository/gitlab/group/sub/x:${SUM}`,
  );
});

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
      image: `tag${BASE_TAG_SUFFIX}`,
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

test("a slot of a project with no environment runs on the container image", async (t) => {
  const { built, calls } = images(temporary(t), {
    environment: null,
    exists: SUCCESS,
  });
  assert.equal(
    await built.imageFor(ContainerRuntime.Podman, slot),
    KANTHORD_IMAGE,
  );
  assert.deepEqual(calls, []);
});

test("a slot runs on an existing environment image of the current slot image id and builds nothing", async (t) => {
  const { built, calls, exports } = images(temporary(t), {
    environment: environment(),
    exists: SUCCESS,
  });
  const tag = environmentTag(
    IDENTITY,
    environmentDigest(environment(), KANTHORD_IMAGE_ID, VERSION),
  );
  assert.equal(await built.imageFor(ContainerRuntime.Podman, slot), tag);
  assert.deepEqual(calls, [
    ["image", "inspect", "--format", "{{.Id}}", KANTHORD_IMAGE],
    ["image", "exists", tag],
  ]);
  assert.deepEqual(exports, []);
});

test("a failed build writes the stored config on a server copy, fails with build_failed and is not retried", async (t) => {
  const directory = temporary(t);
  const { built, exports } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: `import { readFileSync } from "node:fs";
const config = process.argv[process.argv.indexOf("--config") + 1];
process.stderr.write("config " + readFileSync(config, "utf8"));
process.exit(3);`,
  });
  const failed = (error: unknown) => {
    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, ENVIRONMENT_IMAGE_FAILED);
    const fields = new Map(error.fields);
    assert.equal(fields.get("class"), EnvironmentImageFailure.BuildFailed);
    assert.ok(
      String(fields.get("detail")).includes(
        'config {"image":"mcr.microsoft.com/devcontainers/python:3.12"}',
      ),
    );
    return true;
  };
  await assert.rejects(built.imageFor(ContainerRuntime.Podman, slot), failed);
  await assert.rejects(built.imageFor(ContainerRuntime.Podman, slot), failed);
  assert.equal(exports.length, ONE_BUILD);
  assert.equal(existsSync(exports[0]!), false);
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

function reportOf(error: unknown): {
  config: string;
  workspace: string;
  document: Record<string, unknown>;
  feature: boolean;
  variables: string[];
  values: string[];
} {
  assert.ok(error instanceof Diagnostic);
  return JSON.parse(String(new Map(error.fields).get("detail")));
}

function failureOf(error: unknown): { class: string; detail: string } {
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, ENVIRONMENT_IMAGE_FAILED);
  const fields = new Map(error.fields);
  return {
    class: String(fields.get("class")),
    detail: String(fields.get("detail")),
  };
}

async function buildError(built: EnvironmentImages): Promise<unknown> {
  try {
    await built.imageFor(ContainerRuntime.Podman, slot);
  } catch (error) {
    return error;
  }
  assert.fail("The build did not fail.");
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
  const { built } = images(directory, {
    environment: environment({
      name: "dev",
      customizations: { vscode: {} },
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
  const report = reportOf(await buildError(built));
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
  const { built } = images(temporary(t), {
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
  const report = reportOf(await buildError(built));
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
  reportOf(await buildError(stored.built));
  assert.deepEqual(readdirSync(outside), ["Dockerfile"]);
  mkdirSync(join(directory, "dockerfile"));
  const dockerfile = images(join(directory, "dockerfile"), {
    environment: environment({ build: { dockerfile: "Dockerfile" } }),
    exists: ABSENT,
    cli: REPORT_CLI,
    checkout: link,
  });
  assert.deepEqual(failureOf(await buildError(dockerfile.built)), {
    class: EnvironmentImageFailure.BuildFailed,
    detail: "build.dockerfile: the path leaves the checkout",
  });
});

test("a local feature with a symbolic link fails the build and names the feature", async (t) => {
  const { built } = images(temporary(t), {
    environment: environment({ image: "base", features: { "./local": {} } }),
    exists: ABSENT,
    cli: REPORT_CLI,
    checkout: (target) => {
      writeCheckout(target, { ".devcontainer/local/install.sh": "true" });
      symlinkSync("/etc/passwd", join(target, ".devcontainer/local/passwd"));
    },
  });
  assert.deepEqual(failureOf(await buildError(built)), {
    class: EnvironmentImageFailure.BuildFailed,
    detail: "features../local: the feature holds a symbolic link",
  });
});

const TAG = environmentTag(
  IDENTITY,
  environmentDigest(environment(), KANTHORD_IMAGE_ID, VERSION),
);
const STAGING = `${TAG}${STAGING_TAG_SUFFIX}`;

function indexOf(
  lines: string[][],
  match: (line: string[]) => boolean,
): number {
  const index = lines.findIndex(match);
  assert.notEqual(index, NOT_FOUND);
  return index;
}

test("the layer gets the final tag only after the check passes, and concurrent slots share one build", async (t) => {
  const directory = temporary(t);
  const { built, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: SUCCESS }),
  });
  assert.deepEqual(
    await Promise.all([
      built.imageFor(ContainerRuntime.Podman, slot),
      built.imageFor(ContainerRuntime.Podman, slot),
    ]),
    [TAG, TAG],
  );
  const log = lines();
  assert.equal(
    log.filter((line) => line[0] === HOST_LINE && line[2] === EXISTS).length,
    ONE_BUILD,
  );
  assert.equal(
    log.filter((line) => line[0] === PODMAN_LINE && line[1] === BUILD_COMMAND)
      .length,
    ONE_BUILD,
  );
  const build = indexOf(
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
  assert.ok(build < check && check < tagged && tagged < untagged);
  assert.equal(
    log
      .slice(0, tagged)
      .some((line) => line.at(-1) === TAG && line[2] !== EXISTS),
    false,
  );
});

test("the image check runs hardened with the owner label and a failed check removes the container and the staging tag", async (t) => {
  const directory = temporary(t);
  const { built, lines } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: PASSING_CLI,
    variables: fakePodman(directory, { build: SUCCESS, run: ABSENT }),
  });
  const failure = failureOf(await buildError(built));
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

test("a layer variable that a Containerfile line cannot hold fails the build and names the key", async (t) => {
  const directory = temporary(t);
  const { built, lines } = images(directory, {
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
  assert.deepEqual(failureOf(await buildError(built)), {
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

test("a build failure holds for 15 minutes or until the next binding revision", async (t) => {
  let now = 0;
  let current = environment();
  const { built, exports } = images(temporary(t), {
    environment: null,
    exists: ABSENT,
    now: () => now,
    slotEnvironment: () => Promise.resolve(current),
  });
  await buildError(built);
  now = FAILURE_HOLD_MS - 1;
  await buildError(built);
  assert.equal(exports.length, ONE_BUILD);
  now = FAILURE_HOLD_MS;
  await buildError(built);
  assert.equal(exports.length, ONE_BUILD + 1);
  current = { ...environment(), binding_id: "binding-2" };
  await buildError(built);
  assert.equal(exports.length, ONE_BUILD + 2);
});

test("an environment tag of a long identity keeps the name within 255 characters with a hash", () => {
  const long = `repository:gitlab:${"group/".repeat(60)}app`;
  const other = `repository:gitlab:${"group/".repeat(60)}api`;
  const tag = environmentTag(long, SUM);
  const name = tag.slice(0, tag.lastIndexOf(":"));
  assert.ok(name.length <= IMAGE_NAME_MAX_LENGTH);
  assert.match(
    name,
    /^localhost\/kanthord-env\/([a-z0-9]+(-+[a-z0-9]+)*\/)*[a-z0-9]+(-+[a-z0-9]+)*$/,
  );
  assert.match(name, /-[0-9a-f]{16}$/);
  assert.notEqual(environmentTag(other, SUM), tag);
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
import { writeFileSync } from "node:fs";
const child = spawn("sleep", ["30"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`;

async function pidOf(file: string): Promise<number> {
  for (let round = 0; round < WAIT_ROUNDS; round++) {
    if (existsSync(file) && readFileSync(file, "utf8"))
      return Number(readFileSync(file, "utf8"));
    await delay(WAIT_STEP_MS);
  }
  assert.fail("The build did not start.");
}

test("a build past its time limit ends the whole process group", async (t) => {
  const directory = temporary(t);
  const pidFile = join(directory, "pid");
  const { built } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: HANGING_CLI(pidFile),
    buildTimeoutMs: SHORT_TIMEOUT_MS,
  });
  const failure = failureOf(await buildError(built));
  assert.equal(failure.class, EnvironmentImageFailure.BuildFailed);
  assert.match(failure.detail, /time limit/);
  assert.equal(await ended(await pidOf(pidFile)), true);
});

test("a stop ends a running build and a start removes the build directories of an earlier run", async (t) => {
  const directory = temporary(t);
  const stale = join(directory, "environments", "build-stale");
  mkdirSync(stale, { recursive: true });
  const pidFile = join(directory, "pid");
  const { built } = images(directory, {
    environment: environment(),
    exists: ABSENT,
    cli: HANGING_CLI(pidFile),
  });
  assert.equal(existsSync(stale), false);
  const pending = buildError(built);
  const pid = await pidOf(pidFile);
  built.stop();
  await pending;
  assert.equal(await ended(pid), true);
});
