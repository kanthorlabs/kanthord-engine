import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { temporary } from "../kernel/test-support.ts";
import {
  configuration,
  configPath,
  directories,
  initialConfig,
  loadConfig,
  parseMapping,
  showConfig,
} from "./index.ts";
import { writePrivate } from "../kernel/files.ts";
const ExitCode = { Success: 0, Failure: 1 } as const;

const EMPTY_OUTPUT = "";
const CONFIGURED_PORT = 12345;
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_PORT = 31415;
const YAML_VALUE = "ok";
const MAX_SEQUENCE_ENTRIES = 4094;
const CUSTOM_CONFIG_DIRECTORY = "/custom/kanthord";
const FALLBACK_DATA_DIRECTORY = "/home/test/.local/share/kanthord";
const ORIGINAL_CONTENT = "original";
const REPLACEMENT_CONTENT = "replacement";

test("service fragments preserve the existing YAML field set", () => {
  const initial = parseMapping(initialConfig());
  const config = configuration(initial).getProperties();
  assert.deepEqual(Object.keys(initial).sort(), [
    "gateway",
    "log",
    "masterKey",
  ]);
  assert.deepEqual(Object.keys(config.gateway).sort(), [
    "allowedHosts",
    "allowedOrigins",
    "bind",
    "port",
    "tokenLifetime",
  ]);
});

test("configuration is strict, file-only, masks secrets, and reports every invalid field safely", (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.yaml");
  const masterKey = randomBytes(32).toString("base64");
  writePrivate(path, `masterKey: ${masterKey}\ngateway:\n  port: 12345\n`);
  const previous = process.env.GATEWAY_PORT;
  process.env.GATEWAY_PORT = "9999";
  t.after(() => {
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
    () => configuration({ gateway: { bind: "0.0.0.0", port: -1 } }),
    (error: Error) => {
      assert.match(error.message, /masterKey/);
      assert.match(error.message, /gateway.bind/);
      assert.match(error.message, /gateway.port/);
      return true;
    },
  );
  assert.throws(
    () => configuration({ masterKey, unexpected: "secret-marker" }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /secret-marker/);
      return true;
    },
  );
});

test("YAML rejects duplicate keys, extra documents, malformed secrets, arrays, and non-mappings without excerpts", () => {
  for (const source of [
    "masterKey: secret-marker\nmasterKey: again",
    "a: 1\n---\nb: 2",
    "masterKey: [secret-marker",
    "- secret-marker",
    "null",
  ]) {
    assert.throws(
      () => parseMapping(source),
      (error: Error) => {
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  }
  assert.throws(
    () => configuration({ masterKey: "secret-marker" }),
    /masterKey/,
  );
  assert.doesNotThrow(() => configuration(parseMapping(initialConfig())));
});

test("collection keys fail without YAML warnings or configuration excerpts", (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const masterKey = randomBytes(32).toString("base64");
  const sources = [
    "? [secret-marker, test]\n: 1",
    "gateway:\n  ? {secret-marker: test}\n  : 1",
    "extra: &key [secret-marker]\n? *key\n: 1",
  ];
  for (const source of sources) {
    writePrivate(path, `masterKey: ${masterKey}\n${source}\n`, true);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../main.ts", import.meta.url)),
        "config",
        "validate",
        "--config",
        path,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /configuration:/);
    assert.doesNotMatch(result.stderr, /secret-marker|Warning:/);
    assert.ok(!result.stderr.includes(masterKey));
  }
});

test("cyclic aliases fail promptly before Convict validation", (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const masterKey = randomBytes(32).toString("base64");
  for (const source of [
    "extra: &a {self: *a}",
    "gateway: &a {extra: *a}",
    "gateway:\n  allowedHosts: &a [*a]",
  ]) {
    writePrivate(path, `masterKey: ${masterKey}\n${source}\n`, true);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../main.ts", import.meta.url)),
        "config",
        "validate",
        "--config",
        path,
      ],
      { encoding: "utf8", timeout: 1500 },
    );
    assert.ifError(result.error);
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
      () => configuration(parseMapping(`masterKey: ${masterKey}\n${source}`)),
      (error: Error) => {
        assert.match(error.message, /undeclared field/);
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  }
});

test("diagnostics report explicit nulls rather than substituting defaults", () => {
  assert.throws(
    () =>
      configuration({
        masterKey: null,
        log: { level: null, destination: null },
        gateway: {
          bind: null,
          port: -1,
          allowedHosts: null,
          allowedOrigins: null,
          tokenLifetime: null,
        },
      }),
    (error: Error) => {
      assert.equal(
        error.message,
        [
          "masterKey",
          "log.level",
          "log.destination",
          "gateway.bind",
          "gateway.port",
          "gateway.allowedHosts",
          "gateway.allowedOrigins",
          "gateway.tokenLifetime",
        ]
          .map((path) => `${path}: invalid or missing value.`)
          .join("\n"),
      );
      assert.doesNotMatch(error.message, /configuration: invalid field/);
      return true;
    },
  );
  const config = configuration({
    masterKey: randomBytes(32).toString("base64"),
  }).getProperties();
  assert.equal(config.log.level, DEFAULT_LOG_LEVEL);
  assert.equal(config.gateway.port, DEFAULT_PORT);
});

test("bounded YAML retains ordinary aliases and rejects unsafe tags and unresolved aliases", () => {
  const value = parseMapping("first: &hosts [localhost]\nsecond: *hosts");
  assert.deepEqual(value.first, ["localhost"]);
  assert.equal(value.first, value.second);
  const config = configuration({
    masterKey: randomBytes(32).toString("base64"),
    gateway: { allowedHosts: value.first, allowedOrigins: value.second },
  }).getProperties();
  assert.deepEqual(config.gateway.allowedHosts, ["localhost"]);
  assert.deepEqual(config.gateway.allowedOrigins, ["localhost"]);
  for (const source of [
    "value: !secret-marker text",
    "value: *secret-marker",
    "!!set {secret-marker: null}",
  ]) {
    assert.throws(
      () => parseMapping(source),
      (error: Error) => {
        assert.match(error.message, /configuration:/);
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  }
});

test("YAML enforces byte, expanded-value, and nesting limits", () => {
  const atByteLimit = "value: ok\n#".padEnd(1024 * 1024, "x");
  assert.equal(parseMapping(atByteLimit).value, YAML_VALUE);
  assert.throws(() => parseMapping(atByteLimit + "x"), /1 MiB limit/);
  assert.throws(
    () => parseMapping("value: " + "é".repeat(512 * 1024)),
    /1 MiB limit/,
  );
  const atNodeLimit = `values: [${Array<string>(4094).fill("x").join(",")}]`;
  assert.equal(
    (parseMapping(atNodeLimit).values as string[]).length,
    MAX_SEQUENCE_ENTRIES,
  );
  assert.throws(
    () => parseMapping(atNodeLimit.replace("]", ",x]")),
    /too many values/,
  );
  const atDepthLimit = '{"nested":'.repeat(32) + "0" + "}".repeat(32);
  assert.doesNotThrow(() => parseMapping(atDepthLimit));
  assert.throws(
    () => parseMapping(`{nested: ${atDepthLimit}}`),
    /nesting is too deep/,
  );
});

test("programmatic configuration cannot bypass cycle and structure checks", () => {
  const masterKey = randomBytes(32).toString("base64");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(
    () => configuration({ masterKey, extra: cycle }),
    /cyclic aliases/,
  );
  assert.throws(
    () =>
      configuration({
        masterKey,
        gateway: { allowedHosts: Array<string>(4096).fill("localhost") },
      }),
    /too many values/,
  );
  assert.throws(() => configuration({ masterKey, log: null, gateway: [] }), {
    message: "log: expected a mapping.\ngateway: expected a mapping.",
  });
  assert.throws(() => configuration(new Map()), /plain mapping/);
  assert.throws(() => configuration([]), /expected a mapping/);
});

test("XDG absolute directories and config option/environment resolution", () => {
  const paths = directories(
    { XDG_DATA_HOME: "relative", XDG_CONFIG_HOME: "/custom" },
    "/home/test",
  );
  assert.equal(paths.config, CUSTOM_CONFIG_DIRECTORY);
  assert.equal(paths.data, FALLBACK_DATA_DIRECTORY);
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
  assert.throws(() => loadConfig(path), /kanthord config init/);
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
  assert.throws(() => writePrivate(path, "replacement"), /absent destination/);
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
