import type { TestContext } from "node:test";
import { ulid } from "ulid";
import type { InstanceCopyKey } from "../../custody/client.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  machineConfigurationValue,
  WORKER_INSTANCE_ID_PREFIX,
} from "../../worker/contract.ts";
import { type CopyKeys, copyKeys } from "./copy-keys.ts";
import { instanceCopyKey, machineCopyKey } from "./instance-credential.ts";
import { MACHINE_CONFIG_VARIABLE } from "./machine-config.ts";

export const TEST_INSTANCE_NAME = "laptop";
export const TEST_MACHINE_NAME = "workstation";
const TEST_ENDPOINT = "http://127.0.0.1:1";

export type KeyPair = { public_key: Buffer; private_key: Buffer };

export interface CopyKeysFixture {
  env: NodeJS.ProcessEnv;
  keys: CopyKeys;
  instance: { pair: KeyPair; key: InstanceCopyKey };
  machine: { pair: KeyPair; key: InstanceCopyKey };
}

export async function copyKeysFixture(
  t: TestContext,
  options: { machineInEnv: boolean } = { machineInEnv: true },
): Promise<CopyKeysFixture> {
  const root = temporary(t);
  const instancePair = await generateX25519KeyPair();
  const machinePair = await generateX25519KeyPair();
  const instanceConfiguration = {
    name: TEST_INSTANCE_NAME,
    endpoint: TEST_ENDPOINT,
    instance_id: `${WORKER_INSTANCE_ID_PREFIX}_${ulid()}`,
    private_key: instancePair.private_key.toString("base64url"),
  };
  const machineConfiguration = {
    name: TEST_MACHINE_NAME,
    private_key: machinePair.private_key.toString("base64url"),
  };
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  if (options.machineInEnv)
    env[MACHINE_CONFIG_VARIABLE] =
      machineConfigurationValue(machineConfiguration);
  return {
    env,
    keys: copyKeys(instanceConfiguration, env),
    instance: {
      pair: instancePair,
      key: instanceCopyKey(instanceConfiguration),
    },
    machine: { pair: machinePair, key: machineCopyKey(machineConfiguration) },
  };
}
