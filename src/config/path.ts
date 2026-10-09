import { join, resolve } from "node:path";
import { directories } from "../kernel/xdg.ts";

export function configPath(
  option?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    option ??
      env.KANTHORD_CONFIG ??
      join(directories(env).config, "kanthord.yaml"),
  );
}
