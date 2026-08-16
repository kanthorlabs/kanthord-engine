import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeShowResponse } from "../../http/contract/graph.ts";
import { nodeCommand } from "./index.ts";

export type NodeShowCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerNodeShow(input: NodeShowCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "show")) {
    return;
  }
  group
    .command("show")
    .description("show a node")
    .argument("<id>", "node id")
    .action(async (id: string) => {
      const result = await input.client.call("node.show", undefined, { id });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const node = nodeShowResponse.parse(result.body);
      input.stdout(
        `kanthord: node ${node.id} ${node.kind} ${node.state} ${node.title}\n`,
      );
    });
}
