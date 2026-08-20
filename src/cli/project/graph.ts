import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { projectGraphResponse } from "../../http/contract/graph.ts";
import { projectCommand } from "./index.ts";

export type ProjectGraphCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerProjectGraph(input: ProjectGraphCliInput): void {
  const group = projectCommand(input.program);
  if (group.commands.some((command) => command.name() === "graph")) {
    return;
  }
  group
    .command("graph")
    .description("show the graph of a project")
    .option("--id <id>", "project id")
    .action(async (options: { id?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("project.graph", undefined, {
        id: options.id,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }
      const body = projectGraphResponse.parse(result.body);
      input.stdout(`${JSON.stringify(body, null, 2)}\n`);
    });
}
