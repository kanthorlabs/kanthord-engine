import { Diagnostic } from "../../kernel/errors.ts";
import type { InstanceCopyKey } from "../../custody/client.ts";
import type { InstanceConfiguration } from "../../worker/contract.ts";
import { instanceCopyKey, machineCopyKey } from "./instance-credential.ts";
import { CONFIG_ABSENT, readMachineConfiguration } from "./machine-config.ts";

export interface CopyKeys {
  own: InstanceCopyKey;
  of(holder: string): InstanceCopyKey | null;
}

export function copyKeys(
  configuration: InstanceConfiguration,
  env: NodeJS.ProcessEnv,
): CopyKeys {
  const own = instanceCopyKey(configuration);
  return {
    own,
    of(holder) {
      if (holder === own.holder) return own;
      try {
        return machineCopyKey(readMachineConfiguration(env, holder));
      } catch (error) {
        if (error instanceof Diagnostic && error.code === CONFIG_ABSENT)
          return null;
        throw error;
      }
    },
  };
}
