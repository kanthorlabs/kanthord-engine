import type { Command } from "commander";

import { nodeUnblockResponse } from "../../http/contract/outcome.ts";
import type { DaemonClient } from "../client.ts";
import { nodeCommand } from "./index.ts";

export type NodeUnblockCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

type UnblockOptions = Readonly<{ node?: string }>;

export function registerNodeUnblock(input: NodeUnblockCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "unblock")) {
    return;
  }
  group
    .command("unblock")
    .description("return a blocked node to the pool")
    .option("--node <id>", "node id")
    .action(async (options: UnblockOptions) => {
      if (options.node === undefined) {
        input.stderr("kanthord: invalid-request: --node is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("node.unblock", undefined, {
        id: options.node,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }
      const body = nodeUnblockResponse.parse(result.body);
      input.stdout(`kanthord: node ${body.node.id} ${body.node.state}\n`);
    });
}
