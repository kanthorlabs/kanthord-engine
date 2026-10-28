import assert from "node:assert/strict";
import { chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { Diagnostic } from "../../kernel/errors.ts";
import { writePrivate } from "../../kernel/files.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import { temporary } from "../../kernel/test-support.ts";
import { instanceConfigurationValue } from "../../worker/contract.ts";
import {
  decodeInstanceConfiguration,
  InstanceConfigSource,
  instanceDirectories,
  instanceFilePath,
  resolveInstanceConfiguration,
  writeInstanceFile,
} from "./instance-config.ts";

const NAME = "laptop";
const OTHER_NAME = "desktop";
const ENDPOINT = "http://127.0.0.1:31415";
const CONFIG_INVALID = "worker.instance.config_invalid";
const CONFIG_ABSENT = "worker.start.instance_config_absent";
const CONFIG_CONFLICT = "worker.start.instance_config_conflict";
const CONFIG_EXISTS = "cli.worker.join.config_exists";
const INVALID_PERMISSIONS = "system.files.invalid_permissions";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const OPEN_MODE = 0o644;
const PERMISSION_BITS = 0o777;

async function configurationOf(name = NAME) {
  const pair = await generateX25519KeyPair();
  return {
    name,
    endpoint: ENDPOINT,
    instance_id: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    private_key: pair.private_key.toString("base64url"),
  };
}

function environmentOf(t: TestContext): NodeJS.ProcessEnv {
  const root = temporary(t);
  return {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
}

function refuses(task: () => unknown, code: string) {
  assert.throws(task, (error: unknown) => {
    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, code);
    return true;
  });
}

test("the env source decodes the value and names the instance", async (t) => {
  const configuration = await configurationOf();
  const env = {
    ...environmentOf(t),
    KANTHORD_WORKER_CONFIG: instanceConfigurationValue(configuration),
  };
  assert.deepEqual(resolveInstanceConfiguration({}, env), {
    configuration,
    source: InstanceConfigSource.Env,
  });
  assert.deepEqual(
    resolveInstanceConfiguration({ instance: NAME }, env).configuration,
    configuration,
  );
  refuses(
    () => resolveInstanceConfiguration({ instance: OTHER_NAME }, env),
    CONFIG_INVALID,
  );
});

test("the file source reads workers/<name>.yaml with --instance", async (t) => {
  const configuration = await configurationOf();
  const env = environmentOf(t);
  const path = writeInstanceFile(env, configuration, false);
  assert.equal(path, instanceFilePath(env, NAME));
  assert.equal(statSync(path).mode & PERMISSION_BITS, FILE_MODE);
  assert.equal(statSync(dirname(path)).mode & PERMISSION_BITS, DIRECTORY_MODE);
  assert.deepEqual(resolveInstanceConfiguration({ instance: NAME }, env), {
    configuration,
    source: InstanceConfigSource.File,
  });
});

test("both sources for one name refuse the start as a conflict", async (t) => {
  const configuration = await configurationOf();
  const env = environmentOf(t);
  writeInstanceFile(env, configuration, false);
  refuses(
    () =>
      resolveInstanceConfiguration(
        {},
        {
          ...env,
          KANTHORD_WORKER_CONFIG: instanceConfigurationValue(configuration),
        },
      ),
    CONFIG_CONFLICT,
  );
});

test("no source refuses the start and names the path and XDG_CONFIG_HOME", (t) => {
  const env = environmentOf(t);
  assert.throws(
    () => resolveInstanceConfiguration({ instance: NAME }, env),
    (error: unknown) => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, CONFIG_ABSENT);
      assert.deepEqual(error.fields, [
        ["variable", "KANTHORD_WORKER_CONFIG"],
        ["path", instanceFilePath(env, NAME)],
        ["xdg_config_home", env.XDG_CONFIG_HOME],
      ]);
      return true;
    },
  );
  refuses(() => resolveInstanceConfiguration({}, env), CONFIG_ABSENT);
});

test("an invalid value and a file of another name refuse as config_invalid", async (t) => {
  const configuration = await configurationOf();
  const value = instanceConfigurationValue(configuration);
  for (const invalid of [
    `${value}=`,
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ ...configuration, extra: 1 })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        ...configuration,
        private_key: Buffer.alloc(32).toString("base64url"),
      }),
    ).toString("base64url"),
    Buffer.from(JSON.stringify({ ...configuration, name: "server" })).toString(
      "base64url",
    ),
  ])
    refuses(() => decodeInstanceConfiguration(invalid), CONFIG_INVALID);
  const env = environmentOf(t);
  writePrivate(
    instanceFilePath(env, OTHER_NAME),
    stringify({ ...configuration }),
  );
  refuses(
    () => resolveInstanceConfiguration({ instance: OTHER_NAME }, env),
    CONFIG_INVALID,
  );
});

test("a readable instance file refuses the start", async (t) => {
  const env = environmentOf(t);
  const path = writeInstanceFile(env, await configurationOf(), false);
  chmodSync(path, OPEN_MODE);
  refuses(
    () => resolveInstanceConfiguration({ instance: NAME }, env),
    INVALID_PERMISSIONS,
  );
});

test("a write refuses an existing file unless forced", async (t) => {
  const env = environmentOf(t);
  writeInstanceFile(env, await configurationOf(), false);
  const replacement = await configurationOf();
  refuses(() => writeInstanceFile(env, replacement, false), CONFIG_EXISTS);
  writeInstanceFile(env, replacement, true);
  assert.deepEqual(
    resolveInstanceConfiguration({ instance: NAME }, env).configuration,
    replacement,
  );
});

test("the named directories hold the data and the log of one instance", (t) => {
  const env = environmentOf(t);
  assert.deepEqual(instanceDirectories(env, NAME), {
    data: `${env.XDG_DATA_HOME}/kanthord/workers/${NAME}`,
    log: `${env.XDG_STATE_HOME}/kanthord/workers/${NAME}`,
  });
});
