import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeCommand } from "./index.ts";
import { printNodeReportView } from "./report-view.ts";
import { exitCodeForError } from "../exit-code.ts";

export type NodeReportCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

type ReportOptions = Readonly<{
  id?: string;
  outcome?: string;
  fence?: string;
  objectId?: string;
  reason?: string;
}>;

export function registerNodeReport(input: NodeReportCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "report")) {
    return;
  }
  group
    .command("report")
    .description("report a task outcome")
    .option("--id <id>", "node id")
    .option("--outcome <outcome>", "report outcome")
    .option("--fence <n>", "lease fence")
    .option("--object-id <oid>", "reported object id")
    .option("--reason <reason>", "reason for the outcome")
    .action(async (options: ReportOptions) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const fence = Number(options.fence ?? "");
      if (
        !/^[1-9][0-9]*$/.test(options.fence ?? "") ||
        !Number.isSafeInteger(fence)
      ) {
        input.stderr(
          "kanthord: invalid-request: --fence must be a positive integer\n",
        );
        input.fail();
        return;
      }
      const body: Readonly<Record<string, unknown>> = {
        report: options.outcome,
        fence,
        ...(options.objectId !== undefined
          ? { objectId: options.objectId }
          : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      };
      const result = await input.client.call("node.report", body, {
        id: options.id,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }
      printNodeReportView(input.stdout, result.body);
    });
}
