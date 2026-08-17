import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeCommand } from "./index.ts";
import { printNodeReportView } from "./report-view.ts";

export type NodeCloseCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

type CloseOptions = Readonly<{
  id?: string;
  acknowledgePartial?: boolean;
}>;

export function registerNodeClose(input: NodeCloseCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "close")) {
    return;
  }
  group
    .command("close")
    .description("close an attested objective")
    .option("--id <id>", "node id")
    .option("--acknowledge-partial", "acknowledge a derived partial outcome")
    .action(async (options: CloseOptions) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call(
        "node.report",
        {
          report: "closed",
          acknowledgePartial: options.acknowledgePartial === true,
        },
        { id: options.id },
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }
      printNodeReportView(input.stdout, result.body);
    });
}
