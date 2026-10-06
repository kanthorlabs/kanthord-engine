import assert from "node:assert/strict";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";

export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  assert.ok(env);
  const output = { ...env };
  const providerEnv = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const provider of getBuiltinProviders())
    for (const name of findEnvKeys(provider, providerEnv) ?? [])
      delete output[name];
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
  ])
    delete output[name];
  assert.notEqual(output, env);
  return output;
}
