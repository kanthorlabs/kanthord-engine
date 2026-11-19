import { resolve } from "node:path";
import { compareRuns } from "../worker/index.ts";

const NEWLINE = "\n";

export interface TasksCompareIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
}

export async function tasksCompare(
  outputs: readonly [string, string],
  io: TasksCompareIo,
): Promise<void> {
  const comparison = await compareRuns({
    outputs: [resolve(io.cwd, outputs[0]), resolve(io.cwd, outputs[1])],
    env: io.env,
  });
  io.stdout(`${JSON.stringify(comparison)}${NEWLINE}`);
}
