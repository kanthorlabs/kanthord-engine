import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { projectCreateResponse } from "../../http/contract/project.ts";
import { projectCommand } from "./index.ts";
import { printProjectView } from "./view.ts";

export type CreateProjectCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerProjectCreate(input: CreateProjectCliInput): void {
  const group = projectCommand(input.program);
  if (group.commands.some((command) => command.name() === "create")) {
    return;
  }
  group
    .command("create")
    .description("create a project")
    .option("--name <name>", "project name")
    .action(async (options: { name?: string }) => {
      if (options.name === undefined) {
        input.stderr("kanthord: invalid-request: --name is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("project.create", {
        name: options.name,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const view = projectCreateResponse.parse(result.body);
      printProjectView(input.stdout, view);
    });
}
