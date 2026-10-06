import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

export function directories(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const directory = (variable: string, fallback: string) =>
    join(
      env[variable] && isAbsolute(env[variable])
        ? env[variable]
        : join(home, fallback),
      "kanthord",
    );
  return {
    config: directory("XDG_CONFIG_HOME", ".config"),
    data: directory("XDG_DATA_HOME", ".local/share"),
    state: directory("XDG_STATE_HOME", ".local/state"),
    cache: directory("XDG_CACHE_HOME", ".cache"),
  };
}
export type Directories = ReturnType<typeof directories>;

export function homeRelative(path: string, home = homedir()): string {
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
