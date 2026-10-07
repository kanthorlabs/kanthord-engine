import {
  PromptScope,
  SystemPromptSource,
  type PromptSettings,
  type StoredPromptSettings,
} from "./contract.ts";
import type { AgentConfig } from "./config.ts";

export function lockedSwitches(
  scope: PromptScope,
  config: AgentConfig["prompt"],
): string[] {
  return scope === PromptScope.System && !config.host_file
    ? [SystemPromptSource.HostFile]
    : [];
}

export function withLocks(
  settings: StoredPromptSettings,
  config: AgentConfig["prompt"],
): PromptSettings {
  return {
    ...settings,
    locked_switches: lockedSwitches(settings.scope, config),
  };
}

export function applyLocks(
  settings: StoredPromptSettings,
  config: AgentConfig["prompt"],
): StoredPromptSettings {
  return {
    ...settings,
    switches: {
      ...settings.switches,
      ...Object.fromEntries(
        lockedSwitches(settings.scope, config).map((name) => [name, false]),
      ),
    },
  };
}
