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
import { join } from "node:path";
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
  configuration,
  initialConfig,
  loadConfig,
  parseMapping,
  showConfig,
} from "./index.ts";
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
  const config = configuration(parseMapping(initialConfig())).getProperties();
  assert.deepEqual(Object.keys(config.gateway.auth).sort(), [
    "token_lifetime",
    "version",
  ]);
  assert.equal(config.gateway.auth.version, FIRST_AUTH_VERSION);
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
