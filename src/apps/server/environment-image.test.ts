import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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
  EnvironmentImageFailure,
  EnvironmentImages,
  environmentDigest,
  environmentTag,
  imageSettings,
  layerContainerfile,
  STORED_CONFIG_FILE,
} from "./environment-image.ts";

const OWNER = "OWNER";
const KANTHORD_IMAGE = "localhost/kanthord-dev-node:1.0.0";
const VERSION = "1.0.0";
const SUM = "a".repeat(64);
const IDENTITY = "repository:github:Acme/.Todo_App";
const SUCCESS = 0;
const ABSENT = 1;
const FAILED_CLI = "process.exit(3)";
const HEADER_LINES = 3;
const ONE_BUILD = 1;

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
  },
) {
  const calls: string[][] = [];
  const exports: string[] = [];
  const host: RuntimeHost = {
    platform: "linux",
    uid: 1000,
    user: "user",
    environment: process.env,
    exists: () => false,
    resolves: () => true,
    run: (_runtime, args) => {
      calls.push([...args]);
      return Promise.resolve({ code: options.exists, stdout: "", stderr: "" });
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
    slotEnvironment: () => Promise.resolve(options.environment),
    exportRepository: (_binding, _commit, target) => {
      assert.equal(existsSync(target), true);
      exports.push(target);
      return Promise.resolve();
    },
    devcontainerCli: () => cli,
  });
  return { built, calls, exports };
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
      workspace: "/state/workspace",
      config: `/state/workspace/${STORED_CONFIG_FILE}`,
      image: `tag${BASE_TAG_SUFFIX}`,
      owner: OWNER,
    }),
    [
      "/cli/devcontainer.js",
      "build",
      "--docker-path",
      "podman",
      "--workspace-folder",
      "/state/workspace",
      "--config",
      "/state/workspace/.devcontainer/kanthord.devcontainer.json",
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

test("a slot runs on an existing environment image and builds nothing", async (t) => {
  const { built, calls, exports } = images(temporary(t), {
    environment: environment(),
    exists: SUCCESS,
  });
  const tag = environmentTag(
    IDENTITY,
    environmentDigest(environment(), KANTHORD_IMAGE, VERSION),
  );
  assert.equal(await built.imageFor(ContainerRuntime.Podman, slot), tag);
  assert.deepEqual(calls, [["image", "exists", tag]]);
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
