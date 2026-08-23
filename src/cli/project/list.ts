import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { projectListResponse } from "../../http/contract/project.ts";
import { projectCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type ListProjectCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

export function registerProjectList(input: ListProjectCliInput): void {
  const group = projectCommand(input.program);
  if (group.commands.some((command) => command.name() === "list")) {
    return;
  }
  group
    .command("list")
    .description("list projects")
    .action(async () => {
      const result = await input.client.call("project.list", undefined);
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }

      const body = projectListResponse.parse(result.body);
      if (body.projects.length === 0) {
        input.stdout("kanthord: no project\n");
        return;
      }
      for (const project of body.projects) {
        const repositories =
          project.repositories.length === 0
            ? "<none>"
            : project.repositories.join(",");
        input.stdout(
          `kanthord: project ${project.id} ${project.name} ${repositories}\n`,
        );
      }
    });
}
