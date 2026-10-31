import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, type ExecFileException } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  diagnosticText,
  stopAfter,
  temporary,
} from "../kernel/test-support.ts";
import { isNumber } from "../kernel/values.ts";
import {
  CONFIG_VERSION,
  configPath,
  configuration,
  initialConfig,
  loadConfig,
  parseMapping,
  showConfig,
} from "./index.ts";
import {
  DEFAULT_RETENTION_DAYS,
  RETENTION_DAYS_MAX,
} from "../tracking/config.ts";
import {
  DEFAULT_ENVIRONMENT_BUILD_TIMEOUT_MS,
  DEFAULT_ENVIRONMENT_MEMORY_MB,
} from "../project/config.ts";
import { writePrivate } from "../kernel/files.ts";
import { Diagnostic } from "../kernel/errors.ts";

const FIRST_AUTH_VERSION = 1;
const ExitCode = { Success: 0, Failure: 1 } as const;

const EMPTY_OUTPUT = "";
const ABSENT_CONFIGURATION = "configuration is absent";
const INVALID_FIELDS = "invalid configuration fields";
const CONFIGURED_PORT = 12345;
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_PORT = 31415;
const DEFAULT_IDEMPOTENCY_TTL = 86400;
const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 3;
const DEFAULT_REWORK_LIMIT = 2;
const REWORK_OFF = 0;
const DEFAULT_TEXT_MAX_BYTES = 32768;
const DEFAULT_HEARTBEAT_WINDOW = 300;
const DEFAULT_SERVER_INSTANCE_LIMIT = 16;
const DEFAULT_CONTAINER_IMAGE = "docker.io/kanthorlabs/kanthord";
const DEFAULT_RELEASE_RESERVE = 600;
const DEFAULT_STOP_BACKOFF_SECONDS = 30;
const DEFAULT_BUILD_TIMEOUT_MS = 1800000;
const DEFAULT_MEMORY_MB = 4096;
const CONFIGURED_BUILD_TIMEOUT_MS = 600000;
const CONFIGURED_MEMORY_MB = 8192;
const ROOT_BASE_PATH = "/";
const INVALID_FIELD_CODE = "system.config.invalid_field";
const ORIGINAL_CONTENT = "original";
const REPLACEMENT_CONTENT = "replacement";

const execFileAsync = promisify(execFile);
const MAIN_PATH = fileURLToPath(new URL("../main.ts", import.meta.url));

async function mainCommand(args: string[], signal: AbortSignal) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [MAIN_PATH, ...args],
      { encoding: "utf8", signal },
    );
    return { status: ExitCode.Success, stdout, stderr };
  } catch (error) {
    if (signal.aborted) throw error;
    const { code, stdout, stderr } = error as ExecFileException & {
      stdout: string;
      stderr: string;
    };
    return { status: isNumber(code) ? code : null, stdout, stderr };
  }
}

test("service fragments preserve the existing YAML field set", () => {
  const initial = parseMapping(initialConfig());
  const config = configuration(initial).getProperties();
  assert.deepEqual(Object.keys(initial).sort(), [
    "agent",
    "gateway",
    "log",
    "master_key",
    "mission",
    "project",
    "scheduler",
    "tracking",
    "version",
    "worker",
  ]);
  assert.deepEqual(Object.keys(config.worker), [
    "heartbeat_window",
    "server_instance_limit",
    "container_image",
  ]);
  assert.deepEqual(Object.keys(config.scheduler), [
    "release_reserve",
    "stop_backoff",
  ]);
  assert.deepEqual(initial.scheduler, {
    release_reserve: DEFAULT_RELEASE_RESERVE,
    stop_backoff: DEFAULT_STOP_BACKOFF_SECONDS,
  });
  assert.deepEqual(initial.tracking, {
    retention_days: DEFAULT_RETENTION_DAYS,
  });
  assert.deepEqual(initial.worker, {
    heartbeat_window: DEFAULT_HEARTBEAT_WINDOW,
    server_instance_limit: DEFAULT_SERVER_INSTANCE_LIMIT,
    container_image: DEFAULT_CONTAINER_IMAGE,
  });
  assert.deepEqual(Object.keys(config.mission).sort(), [
    "consecutive_failure_limit",
    "further_work_limit",
    "rework_limit",
    "text_max_bytes",
  ]);
  assert.deepEqual(Object.keys(config.gateway).sort(), [
    "allowed_hosts",
    "allowed_origins",
    "auth",
    "base_path",
    "bind",
    "idempotency_ttl",
    "port",
  ]);
  assert.deepEqual(Object.keys(config.gateway.auth).sort(), [
    "token_lifetime",
    "version",
  ]);
  assert.equal(config.gateway.auth.version, FIRST_AUTH_VERSION);
  assert.deepEqual(config.gateway.allowed_origins, [
    "http://127.0.0.1:27182",
    "http://localhost:27182",
  ]);
});

test("gateway base path defaults to the root and accepts only a prefix without a trailing slash", () => {
  const masterKey = randomBytes(32).toString("base64");
  assert.equal(
    configuration({
      version: CONFIG_VERSION,
      master_key: masterKey,
    }).getProperties().gateway.base_path,
    ROOT_BASE_PATH,
  );
  for (const base_path of ["/", "/s/kanthord", "/a.b_c~d-e"])
    assert.equal(
      configuration({
        version: CONFIG_VERSION,
        master_key: masterKey,
        gateway: { base_path },
      }).getProperties().gateway.base_path,
      base_path,
    );
  for (const base_path of [
    "",
    "s/kanthord",
    "/s/kanthord/",
    "//",
    "/s//kanthord",
    "/s kanthord",
    "/s?x",
    1,
    null,
  ])
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: masterKey,
          gateway: { base_path },
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, INVALID_FIELD_CODE);
        assert.match(diagnosticText(error), /gateway\.base_path/);
        return true;
      },
    );
});

test("worker configuration defaults and strict validation", () => {
  const masterKey = randomBytes(32).toString("base64");
  assert.deepEqual(
    configuration({
      version: CONFIG_VERSION,
      master_key: masterKey,
    }).getProperties().worker,
    {
      heartbeat_window: DEFAULT_HEARTBEAT_WINDOW,
      server_instance_limit: DEFAULT_SERVER_INSTANCE_LIMIT,
      container_image: DEFAULT_CONTAINER_IMAGE,
    },
  );
  for (const container_image of [
    "localhost/kanthord-dev",
    "localhost:5000/kanthord",
    "registry.example.com:443/team/kanthord-node",
    "kanthord",
  ])
    assert.equal(
      configuration({
        version: CONFIG_VERSION,
        master_key: masterKey,
        worker: { container_image },
      }).getProperties().worker.container_image,
      container_image,
    );
  for (const worker of [
    { heartbeat_window: 0 },
    { heartbeat_window: -1 },
    { heartbeat_window: 1.5 },
    { heartbeat_window: Number.MAX_SAFE_INTEGER + 1 },
    { server_instance_limit: 0 },
    { server_instance_limit: -1 },
    { server_instance_limit: 1.5 },
    { server_instance_limit: Number.MAX_SAFE_INTEGER + 1 },
    { container_image: "" },
    { container_image: 1 },
    { container_image: "docker.io/kanthorlabs/kanthord:28.0.1" },
    { container_image: "localhost:5000/kanthord:latest" },
    { container_image: "docker.io/kanthorlabs/kanthord@sha256:0123" },
    { globalPrompt: "prompts/global.md" },
    { unknown: true },
  ]) {
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: masterKey,
          worker,
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, INVALID_FIELD_CODE);
        assert.match(diagnosticText(error), /worker/);
        return true;
      },
    );
  }
});

test("agent prompt configuration defaults the agent directory to agents and accepts strings", () => {
  const masterKey = randomBytes(32).toString("base64");
  assert.deepEqual(
    configuration({
      version: CONFIG_VERSION,
      master_key: masterKey,
    }).getProperties().agent,
    {
      prompt: { agent_directory: "agents" },
      cooldown: {
        rate_limited_ms: 60000,
        unavailable_ms: 60000,
        quota_exhausted_ms: 3600000,
        max_ms: 86400000,
      },
    },
  );
  const prompt = { agent_directory: "/agents" };
  assert.deepEqual(
    configuration({
      version: CONFIG_VERSION,
      master_key: masterKey,
      agent: { prompt },
    }).getProperties().agent.prompt,
    prompt,
  );
  for (const bad of [
    { agent_directory: null },
    { agent_directory: 1 },
    { system_file: "" },
    { host_file: true },
    { x: "" },
  ])
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: masterKey,
          agent: { prompt: bad },
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, INVALID_FIELD_CODE);
        return true;
      },
    );
});

test("config init emits Worker and Scheduler fields", async (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const result = await mainCommand(
    ["config", "init", "--config", path],
    t.signal,
  );
  assert.equal(result.status, ExitCode.Success);
  assert.deepEqual(parseMapping(readFileSync(path, "utf8")).worker, {
    heartbeat_window: DEFAULT_HEARTBEAT_WINDOW,
    server_instance_limit: DEFAULT_SERVER_INSTANCE_LIMIT,
    container_image: DEFAULT_CONTAINER_IMAGE,
  });
  assert.deepEqual(parseMapping(readFileSync(path, "utf8")).scheduler, {
    release_reserve: DEFAULT_RELEASE_RESERVE,
    stop_backoff: DEFAULT_STOP_BACKOFF_SECONDS,
  });
});

test("Scheduler reserve accepts only a positive safe integer", () => {
  const masterKey = randomBytes(32).toString("base64");
  assert.equal(
    configuration({
      version: CONFIG_VERSION,
      master_key: masterKey,
    }).getProperties().scheduler.release_reserve,
    DEFAULT_RELEASE_RESERVE,
  );
  for (const releaseReserve of [
    0,
    -1,
    1.5,
    "600",
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: masterKey,
          scheduler: { release_reserve: releaseReserve },
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, INVALID_FIELD_CODE);
        assert.match(diagnosticText(error), /scheduler.release_reserve/);
        return true;
      },
    );
  }
});

test("Tracking retention accepts only a safe integer from 1 to 3650", () => {
  const masterKey = randomBytes(32).toString("base64");
  for (const retentionDays of [0, RETENTION_DAYS_MAX + 1, 1.5]) {
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: masterKey,
          tracking: { retention_days: retentionDays },
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, INVALID_FIELD_CODE);
        assert.match(diagnosticText(error), /tracking.retention_days/);
        return true;
      },
    );
  }
  for (const retentionDays of [1, RETENTION_DAYS_MAX])
    assert.equal(
      configuration({
        version: CONFIG_VERSION,
        master_key: masterKey,
        tracking: { retention_days: retentionDays },
      }).getProperties().tracking.retention_days,
      retentionDays,
    );
});

test("project configuration defaults to the environment run limits", () => {
  const properties = configuration({
    version: CONFIG_VERSION,
    master_key: randomBytes(32).toString("base64"),
  }).getProperties();
  assert.equal(
    properties.project.environment_build_timeout_ms,
    DEFAULT_ENVIRONMENT_BUILD_TIMEOUT_MS,
  );
  assert.equal(
    properties.project.environment_memory_mb,
    DEFAULT_ENVIRONMENT_MEMORY_MB,
  );
  assert.equal(DEFAULT_ENVIRONMENT_BUILD_TIMEOUT_MS, DEFAULT_BUILD_TIMEOUT_MS);
  assert.equal(DEFAULT_ENVIRONMENT_MEMORY_MB, DEFAULT_MEMORY_MB);
});

test("project configuration reads back the configured environment run limits", () => {
  const { project } = configuration({
    version: CONFIG_VERSION,
    master_key: randomBytes(32).toString("base64"),
    project: {
      environment_build_timeout_ms: CONFIGURED_BUILD_TIMEOUT_MS,
      environment_memory_mb: CONFIGURED_MEMORY_MB,
    },
  }).getProperties();
  assert.equal(
    project.environment_build_timeout_ms,
    CONFIGURED_BUILD_TIMEOUT_MS,
  );
  assert.equal(project.environment_memory_mb, CONFIGURED_MEMORY_MB);
});

test("project configuration refuses an environment run limit below its bound, a fraction or a string", () => {
  const masterKey = randomBytes(32).toString("base64");
  const refused = [
    { environment_build_timeout_ms: 59999 },
    { environment_build_timeout_ms: 60000.5 },
    { environment_build_timeout_ms: "600000" },
    { environment_memory_mb: 255 },
  ];
  for (const project of refused)
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: masterKey,
          project,
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, INVALID_FIELD_CODE);
        assert.match(
          diagnosticText(error),
          new RegExp(`project.${Object.keys(project)[0]}`),
        );
        return true;
      },
    );
});

test("mission configuration defaults and strict validation", () => {
  const masterKey = randomBytes(32).toString("base64");
  const mission = configuration({
    version: CONFIG_VERSION,
    master_key: masterKey,
  }).getProperties().mission;
  assert.equal(
    mission.consecutive_failure_limit,
    DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  );
  assert.equal(mission.rework_limit, DEFAULT_REWORK_LIMIT);
  assert.equal(mission.text_max_bytes, DEFAULT_TEXT_MAX_BYTES);
  assert.doesNotThrow(() =>
    configuration({
      version: CONFIG_VERSION,
      master_key: masterKey,
      mission: {
        consecutive_failure_limit: DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
        rework_limit: REWORK_OFF,
      },
    }),
  );
  for (const invalidMission of [
    { unknown: true },
    { consecutive_failure_limit: -1 },
    { rework_limit: -1 },
  ]) {
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: masterKey,
          mission: invalidMission,
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, INVALID_FIELD_CODE);
        assert.match(diagnosticText(error), /mission/);
        return true;
      },
    );
  }
});

test("configuration is strict, file-only, masks secrets, and reports every invalid field safely", (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.yaml");
  const masterKey = randomBytes(32).toString("base64");
  writePrivate(
    path,
    `version: ${CONFIG_VERSION}\nmaster_key: ${masterKey}\ngateway:\n  port: 12345\n`,
  );
  const previous = process.env.GATEWAY_PORT;
  process.env.GATEWAY_PORT = "9999";
  stopAfter(t, () => {
    if (previous === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = previous;
  });
  assert.equal(loadConfig(path).gateway.port, CONFIGURED_PORT);
  assert.equal(loadConfig(path).gateway.bind, DEFAULT_BIND);
  assert.doesNotMatch(
    showConfig(path),
    new RegExp(masterKey.replace(/[+]/g, "\\+")),
  );
  assert.match(showConfig(path), /\[Sensitive\]/);
  assert.throws(
    () =>
      configuration({
        version: CONFIG_VERSION,
        gateway: { bind: "localhost", port: -1 },
      }),
    (error: Error) => {
      assert.match(diagnosticText(error), /master_key/);
      assert.match(diagnosticText(error), /gateway.bind/);
      assert.match(diagnosticText(error), /gateway.port/);
      return true;
    },
  );
  assert.throws(
    () =>
      configuration({
        version: CONFIG_VERSION,
        master_key: masterKey,
        unexpected: "secret-marker",
      }),
    (error: Error) => {
      assert.doesNotMatch(diagnosticText(error), /secret-marker/);
      return true;
    },
  );
});

test("configuration rejects malformed secrets and accepts its initial document", () => {
  assert.throws(
    () =>
      configuration({ version: CONFIG_VERSION, master_key: "secret-marker" }),
    (error) => /master_key/.test(diagnosticText(error)),
  );
  assert.doesNotThrow(() => configuration(parseMapping(initialConfig())));
});

test("collection keys fail without YAML warnings or configuration excerpts", async (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const masterKey = randomBytes(32).toString("base64");
  const sources = [
    "? [secret-marker, test]\n: 1",
    "gateway:\n  ? {secret-marker: test}\n  : 1",
    "extra: &key [secret-marker]\n? *key\n: 1",
  ];
  for (const source of sources) {
    writePrivate(path, `master_key: ${masterKey}\n${source}\n`, true);
    const result = await mainCommand(
      ["config", "validate", "--config", path],
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /configuration:/);
    assert.doesNotMatch(result.stderr, /secret-marker|Warning:/);
    assert.ok(!result.stderr.includes(masterKey));
  }
});

test("cyclic aliases fail promptly before Convict validation", async (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const masterKey = randomBytes(32).toString("base64");
  for (const source of [
    "extra: &a {self: *a}",
    "gateway: &a {extra: *a}",
    "gateway:\n  allowed_hosts: &a [*a]",
  ]) {
    writePrivate(path, `master_key: ${masterKey}\n${source}\n`, true);
    const result = await mainCommand(
      ["config", "validate", "--config", path],
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /configuration:/);
    assert.doesNotMatch(result.stderr, /Warning:|RangeError/);
  }
});

test("strict validation rejects dotted and prototype keys before Convict can discard them", () => {
  const masterKey = randomBytes(32).toString("base64");
  for (const source of [
    "gateway.port: -1",
    "log.level: fatal",
    "__proto__: {secret-marker: ignored}",
    "constructor: {prototype: {secret-marker: ignored}}",
    "gateway:\n  __proto__: {secret-marker: ignored}",
  ]) {
    assert.throws(
      () =>
        configuration(
          parseMapping(
            `version: ${CONFIG_VERSION}\nmaster_key: ${masterKey}\n${source}`,
          ),
        ),
      (error: Error) => {
        assert.match(diagnosticText(error), /undeclared field/);
        assert.doesNotMatch(diagnosticText(error), /secret-marker/);
        return true;
      },
    );
  }
});

test("diagnostics report explicit nulls rather than substituting defaults", () => {
  assert.throws(
    () =>
      configuration({
        version: CONFIG_VERSION,
        master_key: null,
        log: { level: null, destination: null },
        gateway: {
          bind: null,
          port: -1,
          allowed_hosts: null,
          allowed_origins: null,
          auth: { token_lifetime: null },
        },
      }),
    (error: Error) => {
      assert.equal(error.message, INVALID_FIELDS);
      assert.deepEqual(
        (error as Diagnostic).details,
        [
          "master_key",
          "log.level",
          "log.destination",
          "gateway.bind",
          "gateway.port",
          "gateway.allowed_hosts",
          "gateway.allowed_origins",
          "gateway.auth.token_lifetime",
        ].map((path) => `${path}: invalid or missing value.`),
      );
      assert.doesNotMatch(
        diagnosticText(error),
        /configuration: invalid field/,
      );
      return true;
    },
  );
  const config = configuration({
    version: CONFIG_VERSION,
    master_key: randomBytes(32).toString("base64"),
  }).getProperties();
  assert.equal(config.log.level, DEFAULT_LOG_LEVEL);
  assert.equal(config.gateway.port, DEFAULT_PORT);
  assert.equal(config.gateway.idempotency_ttl, DEFAULT_IDEMPOTENCY_TTL);
  for (const idempotencyTtl of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        configuration({
          version: CONFIG_VERSION,
          master_key: randomBytes(32).toString("base64"),
          gateway: { idempotency_ttl: idempotencyTtl },
        }),
      (error) => /gateway.idempotency_ttl/.test(diagnosticText(error)),
    );
});

test("configuration accepts ordinary aliases", () => {
  const value = parseMapping("first: &hosts [localhost]\nsecond: *hosts");
  const config = configuration({
    version: CONFIG_VERSION,
    master_key: randomBytes(32).toString("base64"),
    gateway: { allowed_hosts: value.first, allowed_origins: value.second },
  }).getProperties();
  assert.deepEqual(config.gateway.allowed_hosts, ["localhost"]);
  assert.deepEqual(config.gateway.allowed_origins, ["localhost"]);
});

test("programmatic configuration cannot bypass cycle and structure checks", () => {
  const masterKey = randomBytes(32).toString("base64");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(
    () =>
      configuration({
        version: CONFIG_VERSION,
        master_key: masterKey,
        extra: cycle,
      }),
    /cyclic aliases/,
  );
  assert.throws(
    () =>
      configuration({
        version: CONFIG_VERSION,
        master_key: masterKey,
        gateway: { allowed_hosts: Array<string>(4096).fill("localhost") },
      }),
    /too many values/,
  );
  assert.throws(
    () =>
      configuration({
        version: CONFIG_VERSION,
        master_key: masterKey,
        log: null,
        gateway: [],
      }),
    (error) =>
      error instanceof Diagnostic &&
      isDeepStrictEqual(error.details, [
        "log: expected a mapping.",
        "gateway: expected a mapping.",
      ]),
  );
  assert.throws(() => configuration(new Map()), /plain mapping/);
  assert.throws(
    () => configuration([]),
    (error) => /expected a mapping/.test(diagnosticText(error)),
  );
});

test("config option/environment resolution", () => {
  assert.equal(
    configPath("override.yaml", { KANTHORD_CONFIG: "other.yaml" }),
    resolve("override.yaml"),
  );
  assert.equal(
    configPath(undefined, { KANTHORD_CONFIG: "other.yaml" }),
    resolve("other.yaml"),
  );
});

test("private configuration rejects modes, symlinks and wrong kinds, and creates nothing on validation", (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.yaml");
  assert.throws(
    () => loadConfig(path),
    (error) =>
      error instanceof Diagnostic &&
      error.message === ABSENT_CONFIGURATION &&
      isDeepStrictEqual(error.fields, [
        ["config", path],
        ["command", `kanthord config init --config ${JSON.stringify(path)}`],
        [
          "container",
          "podman run --rm -v <volume>:/var/lib/kanthord docker.io/kanthorlabs/kanthord:<version> config init --gateway-bind :: --gateway-allowed-host localhost:<port> --gateway-allowed-host 127.0.0.1:<port>",
        ],
      ]),
  );
  assert.deepEqual(readdirSync(directory), []);
  writePrivate(path, initialConfig());
  chmodSync(path, 0o644);
  assert.throws(() => loadConfig(path), /mode 600/);
  chmodSync(path, 0o400);
  assert.throws(() => loadConfig(path), /mode 600/);
  chmodSync(path, 0o600);
  const link = join(directory, "link.yaml");
  symlinkSync(path, link);
  assert.throws(() => loadConfig(link), /owned file/);
  chmodSync(directory, 0o755);
  assert.throws(() => loadConfig(path), /mode 700/);
  chmodSync(directory, 0o700);
  const wrong = join(directory, "directory.yaml");
  mkdirSync(wrong, { mode: 0o700 });
  assert.throws(() => loadConfig(wrong), /owned file/);
});

test("atomic writes preserve existing init destinations and clean failed publications", (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.yaml");
  writePrivate(path, "original");
  assert.throws(
    () => writePrivate(path, "replacement"),
    /destination must be absent/,
  );
  assert.equal(readFileSync(path, "utf8"), ORIGINAL_CONTENT);
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
  writePrivate(path, "replacement", true);
  assert.equal(readFileSync(path, "utf8"), REPLACEMENT_CONTENT);
  writeFileSync(join(directory, "blocker"), "x", { mode: 0o600 });
  assert.throws(() =>
    writePrivate(join(directory, "blocker", "file"), "bytes"),
  );
  assert.deepEqual(readdirSync(directory).sort(), ["blocker", "kanthord.yaml"]);
});
