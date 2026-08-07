import type { Command } from "commander";

import type { DaemonClient } from "./client.ts";
import { exitCodeForError } from "./exit-code.ts";

export type RunCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
}>;

export function registerRun(input: RunCliInput): void {
  input.program
    .command("run")
    .description("start a project run")
    .option("--project <id>", "the project to run")
    .action(async (options) => {
      if (options.project === undefined) {
        input.stderr("kanthord: invalid-request: --project is required\n");
        input.exit(1);
        return;
      }

      const result = await input.client.call("run.start", undefined, {
        id: options.project,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }

      input.stdout("kanthord: started\n");
    });
}
