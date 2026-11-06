import assert from "node:assert/strict";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { Diagnostic } from "../../kernel/errors.ts";
import { writePrivate } from "../../kernel/files.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import { temporary } from "../../kernel/test-support.ts";
import { machineConfigurationValue } from "../../worker/contract.ts";
import {
  decodeMachineConfiguration,
  machineFilePath,
  readMachineConfiguration,
  writeMachineFile,
} from "./machine-config.ts";

const NAME = "workstation";
const OTHER_NAME = "build-box";
const BREAKING_NAME = "../escape";
const RESERVED_NAME = "server";
const CONFIG_INVALID = "worker.machine.config_invalid";
const CONFIG_ABSENT = "worker.machine.config_absent";
const CONFIG_CONFLICT = "worker.machine.config_conflict";
const CONFIG_EXISTS = "cli.worker.machine.config_exists";
const INVALID_PERMISSIONS = "system.files.invalid_permissions";
const VARIABLE = "KANTHORD_MACHINE_CONFIG";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const OPEN_MODE = 0o644;
const PERMISSION_BITS = 0o777;

async function configurationOf(name = NAME) {
  const pair = await generateX25519KeyPair();
  return { name, private_key: pair.private_key.toString("base64url") };
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

test("the env source decodes the value of the requested machine", async (t) => {
  const configuration = await configurationOf();
  const env = {
    ...environmentOf(t),
    [VARIABLE]: machineConfigurationValue(configuration),
  };
  assert.deepEqual(readMachineConfiguration(env, NAME), configuration);
});

test("the file source reads machines/<name>.yaml", async (t) => {
  const configuration = await configurationOf();
  const env = environmentOf(t);
  const path = writeMachineFile(env, configuration, false);
  assert.equal(path, machineFilePath(env, NAME));
  assert.equal(path, `${env.XDG_CONFIG_HOME}/kanthord/machines/${NAME}.yaml`);
  assert.equal(statSync(path).mode & PERMISSION_BITS, FILE_MODE);
  assert.equal(statSync(dirname(path)).mode & PERMISSION_BITS, DIRECTORY_MODE);
  assert.deepEqual(readMachineConfiguration(env, NAME), configuration);
});

test("both sources for one name refuse as a conflict", async (t) => {
  const configuration = await configurationOf();
  const env = environmentOf(t);
  writeMachineFile(env, configuration, false);
  refuses(
    () =>
      readMachineConfiguration(
        { ...env, [VARIABLE]: machineConfigurationValue(configuration) },
        NAME,
      ),
    CONFIG_CONFLICT,
  );
});

test("no source refuses and names the variable and the path", (t) => {
  const env = environmentOf(t);
  assert.throws(
    () => readMachineConfiguration(env, NAME),
    (error: unknown) => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, CONFIG_ABSENT);
      assert.deepEqual(error.fields, [
        ["variable", VARIABLE],
        ["path", machineFilePath(env, NAME)],
      ]);
      return true;
    },
  );
});

test("an invalid value refuses as config_invalid", async (t) => {
  const configuration = await configurationOf();
  const value = machineConfigurationValue(configuration);
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
    Buffer.from(
      JSON.stringify({ ...configuration, name: RESERVED_NAME }),
    ).toString("base64url"),
  ])
    refuses(() => decodeMachineConfiguration(invalid), CONFIG_INVALID);
  const env = { ...environmentOf(t), [VARIABLE]: `${value}=` };
  refuses(() => readMachineConfiguration(env, NAME), CONFIG_INVALID);
});

test("an env value or a file of another machine refuses as config_invalid", async (t) => {
  const configuration = await configurationOf();
  const env = environmentOf(t);
  refuses(
    () =>
      readMachineConfiguration(
        { ...env, [VARIABLE]: machineConfigurationValue(configuration) },
        OTHER_NAME,
      ),
    CONFIG_INVALID,
  );
  writePrivate(machineFilePath(env, OTHER_NAME), stringify(configuration));
  refuses(() => readMachineConfiguration(env, OTHER_NAME), CONFIG_INVALID);
});

test("a name that breaks the name form refuses before any path or file read", async (t) => {
  const configuration = await configurationOf();
  const env = environmentOf(t);
  for (const name of [BREAKING_NAME, RESERVED_NAME])
    refuses(() => readMachineConfiguration(env, name), CONFIG_INVALID);
  refuses(
    () =>
      readMachineConfiguration(
        { ...env, [VARIABLE]: machineConfigurationValue(configuration) },
        BREAKING_NAME,
      ),
    CONFIG_INVALID,
  );
});

test("a readable machine file refuses the read", async (t) => {
  const env = environmentOf(t);
  const path = writeMachineFile(env, await configurationOf(), false);
  chmodSync(path, OPEN_MODE);
  refuses(() => readMachineConfiguration(env, NAME), INVALID_PERMISSIONS);
});

test("a write refuses an existing file unless forced", async (t) => {
  const env = environmentOf(t);
  writeMachineFile(env, await configurationOf(), false);
  const replacement = await configurationOf();
  refuses(() => writeMachineFile(env, replacement, false), CONFIG_EXISTS);
  writeMachineFile(env, replacement, true);
  assert.deepEqual(readMachineConfiguration(env, NAME), replacement);
});

test("a write of a name that breaks the name form writes no file", async (t) => {
  const env = environmentOf(t);
  const configuration = await configurationOf(BREAKING_NAME);
  refuses(() => writeMachineFile(env, configuration, false), CONFIG_INVALID);
  refuses(() => writeMachineFile(env, configuration, true), CONFIG_INVALID);
  assert.equal(existsSync(`${env.XDG_CONFIG_HOME}/kanthord`), false);
  assert.equal(existsSync(`${env.XDG_CONFIG_HOME}/escape.yaml`), false);
});
