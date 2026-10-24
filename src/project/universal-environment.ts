import { shippedAsset } from "../kernel/assets.ts";
import {
  parseEnvironmentText,
  type Environment,
} from "../kernel/devcontainer.ts";

const UNIVERSAL_ASSET = "environment/universal.json";

let universal: Environment | undefined;

export function universalEnvironment(): Environment {
  if (universal !== undefined) return universal;
  const parsed = parseEnvironmentText(shippedAsset(UNIVERSAL_ASSET));
  if (parsed.document === null)
    throw new Error(`${UNIVERSAL_ASSET}: ${parsed.error}`);
  universal = parsed.document;
  return universal;
}
