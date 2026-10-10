import { parseDocument } from "yaml";
import { parseMapping } from "../kernel/yaml.ts";
import {
  CONFIG_STEPS,
  CONFIG_VERSION,
  CONFIG_VERSION_FIELD,
  type ConfigChange,
} from "./steps.ts";
import { configuration, configVersion } from "./index.ts";

export interface ConfigUpgrade {
  readonly from: number;
  readonly to: number;
  readonly changes: readonly ConfigChange[];
  readonly content: string | null;
}

export function upgradeConfig(original: string): ConfigUpgrade {
  const from = configVersion(parseMapping(original));
  if (from === CONFIG_VERSION)
    return { from, to: CONFIG_VERSION, changes: [], content: null };
  const document = parseDocument(original);
  const changes = CONFIG_STEPS.slice(from - 1).flatMap((step) =>
    step(document),
  );
  document.set(CONFIG_VERSION_FIELD, CONFIG_VERSION);
  const content = document.toString();
  configuration(parseMapping(content));
  return { from, to: CONFIG_VERSION, changes, content };
}
