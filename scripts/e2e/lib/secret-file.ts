import { chmod, unlink, writeFile } from "node:fs/promises";

import { secrets } from "./redact.ts";
import type { ScenarioContext } from "./scenario/context.ts";

export async function writeSecretFile(
  context: ScenarioContext,
  path: string,
  value: string,
): Promise<string> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);

  secrets.hold(value);

  context.take({
    kind: "file",
    id: path,
    async release(): Promise<void> {
      await unlink(path);
    },
  });

  return path;
}
