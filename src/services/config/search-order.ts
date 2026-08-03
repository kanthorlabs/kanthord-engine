import path from "node:path";

export type SearchOrderInput = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  homeDir: string;
  etcDir: string;
}>;

export function searchOrder(input: SearchOrderInput): readonly string[] {
  const candidates: string[] = [];

  const envConfig = input.env.KANTHORD_CONFIG;
  if (envConfig !== undefined && envConfig.length > 0) {
    candidates.push(path.resolve(input.cwd, envConfig));
  }

  candidates.push(path.join(input.cwd, "kanthord.config.json"));

  const configHome =
    input.env.XDG_CONFIG_HOME ?? path.join(input.homeDir, ".config");
  candidates.push(path.join(configHome, "kanthord", "config.json"));

  candidates.push(path.join(input.etcDir, "kanthord", "config.json"));

  return candidates;
}
