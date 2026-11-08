import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic } from "../../kernel/errors.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import {
  copyKeysFixture,
  TEST_INSTANCE_NAME,
  TEST_MACHINE_NAME,
} from "./copy-keys-test-support.ts";
import type { CopyKeys } from "./copy-keys.ts";
import { machineCopyKey } from "./instance-credential.ts";
import { writeMachineFile } from "./machine-config.ts";

const OTHER_NAME = "build-box";
const RESERVED_NAME = "server";
const CONFIG_INVALID = "worker.machine.config_invalid";
const CONFIG_CONFLICT = "worker.machine.config_conflict";

function sameKey(
  actual: ReturnType<CopyKeys["of"]>,
  expected: ReturnType<typeof machineCopyKey>,
) {
  assert.ok(actual);
  assert.equal(actual.holder, expected.holder);
  assert.equal(actual.sealed_to, expected.sealed_to);
  assert.deepEqual(actual.public_key, expected.public_key);
  assert.deepEqual(actual.private_key(), expected.private_key());
}

test("of answers the instance key for the instance name", async (t) => {
  const f = await copyKeysFixture(t);
  assert.equal(f.keys.own.holder, TEST_INSTANCE_NAME);
  sameKey(f.keys.of(TEST_INSTANCE_NAME), f.instance.key);
  sameKey(f.keys.own, f.instance.key);
});

test("of answers the machine key of the environment value", async (t) => {
  const f = await copyKeysFixture(t);
  const key = f.keys.of(TEST_MACHINE_NAME);
  sameKey(key, f.machine.key);
  assert.equal(key?.holder, TEST_MACHINE_NAME);
});

test("of answers the machine key of the machine file and reads the file at each call", async (t) => {
  const f = await copyKeysFixture(t, { machineInEnv: false });
  assert.equal(f.keys.of(TEST_MACHINE_NAME), null);
  const configuration = (pair: { private_key: Buffer }) => ({
    name: TEST_MACHINE_NAME,
    private_key: pair.private_key.toString("base64url"),
  });
  writeMachineFile(f.env, configuration(f.machine.pair), false);
  sameKey(f.keys.of(TEST_MACHINE_NAME), f.machine.key);
  const replaced = await generateX25519KeyPair();
  writeMachineFile(f.env, configuration(replaced), true);
  const next = f.keys.of(TEST_MACHINE_NAME);
  sameKey(next, machineCopyKey(configuration(replaced)));
  assert.notEqual(next?.sealed_to, f.machine.key.sealed_to);
});

test("of answers null for a name with no machine configuration", async (t) => {
  const f = await copyKeysFixture(t, { machineInEnv: false });
  assert.equal(f.keys.of(OTHER_NAME), null);
});

test("of propagates a conflict and an invalid name", async (t) => {
  const f = await copyKeysFixture(t);
  writeMachineFile(
    f.env,
    {
      name: TEST_MACHINE_NAME,
      private_key: f.machine.pair.private_key.toString("base64url"),
    },
    false,
  );
  assert.throws(
    () => f.keys.of(TEST_MACHINE_NAME),
    (error: unknown) =>
      error instanceof Diagnostic && error.code === CONFIG_CONFLICT,
  );
  assert.throws(
    () => f.keys.of(RESERVED_NAME),
    (error: unknown) =>
      error instanceof Diagnostic && error.code === CONFIG_INVALID,
  );
});
