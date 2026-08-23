import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeListResponse } from "../../http/contract/graph.ts";
import { projectCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type ProjectNodeCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

export function registerProjectNode(input: ProjectNodeCliInput): void {
  const group = projectCommand(input.program);
  if (group.commands.some((command) => command.name() === "node")) {
    return;
  }
  group
    .command("node")
    .description("list nodes of a project")
    .option("--id <id>", "project id")
    .action(async (options: { id?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("project.nodes", undefined, {
        id: options.id,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }
      const body = nodeListResponse.parse(result.body);
      if (body.nodes.length === 0) {
        input.stdout("kanthord: no node\n");
        return;
      }
      for (const node of body.nodes) {
        input.stdout(
          `kanthord: node ${node.id} ${node.kind} ${node.state} ${node.title}\n`,
        );
      }
    });
}
