import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { projectShowResponse } from "../../http/contract/project.ts";
import { projectCommand } from "./index.ts";
import { printProjectView } from "./view.ts";
import { exitCodeForError } from "../exit-code.ts";

export type ShowProjectCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

export function registerProjectShow(input: ShowProjectCliInput): void {
  const group = projectCommand(input.program);
  if (group.commands.some((command) => command.name() === "show")) {
    return;
  }
  group
    .command("show")
    .description("show a project")
    .option("--id <id>", "project id")
    .action(async (options: { id?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("project.show", undefined, {
        id: options.id,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }

      const view = projectShowResponse.parse(result.body);
      printProjectView(input.stdout, view);
    });
}
