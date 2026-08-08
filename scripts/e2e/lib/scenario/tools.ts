import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import type { DaemonConfig } from "../driver/index.ts";

function resolveOnPath(name: string): string {
  const searchPath = process.env.PATH ?? "";
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`${name} not found on PATH`);
}

export function resolveTools(): DaemonConfig["tools"] {
  return {
    git: resolveOnPath("git"),
    ssh: resolveOnPath("ssh"),
    sshKeyscan: resolveOnPath("ssh-keyscan"),
  };
}
