import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeCommand } from "./index.ts";
import { printNodeReportView } from "./report-view.ts";
import { exitCodeForError } from "../exit-code.ts";

export type NodeCloseCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

type CloseOptions = Readonly<{
  id?: string;
  runId?: string;
  runFence?: string;
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
    .requiredOption("--run-id <id>", "run id")
    .requiredOption("--run-fence <n>", "run fence")
    .option("--acknowledge-partial", "acknowledge a derived partial outcome")
    .action(async (options: CloseOptions) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      if (options.runId === undefined) {
        input.stderr("kanthord: invalid-request: --run-id is required\n");
        input.fail();
        return;
      }
      const runFence = Number(options.runFence ?? "");
      if (
        !/^[1-9][0-9]*$/.test(options.runFence ?? "") ||
        !Number.isSafeInteger(runFence)
      ) {
        input.stderr(
          "kanthord: invalid-request: --run-fence must be a positive integer\n",
        );
        input.fail();
        return;
      }
      const result = await input.client.call(
        "node.report",
        {
          report: "closed",
          runId: options.runId,
          runFence,
          acknowledgePartial: options.acknowledgePartial === true,
        },
        { id: options.id },
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }
      printNodeReportView(input.stdout, result.body);
    });
}
