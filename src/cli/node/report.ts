import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { objectId } from "../../domain/column.ts";
import {
  taskReportOutcomes,
  type TaskReportOutcome,
} from "../../domain/outcome-report.ts";
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

function isTaskReportOutcome(value: string): value is TaskReportOutcome {
  return taskReportOutcomes.includes(value as TaskReportOutcome);
}

export function registerNodeReport(input: NodeReportCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "report")) {
    return;
  }
  group
    .command("report")
    .description("report a task outcome")
    .option("--id <id>", "node id")
    .option(
      "--outcome <outcome>",
      "task outcome: accepted, rejected, failed, or cancelled",
    )
    .option("--fence <n>", "lease fence")
    .option(
      "--object-id <oid>",
      "40- or 64-hex object id; required for accepted",
    )
    .option(
      "--reason <reason>",
      "required for rejected/failed; optional for cancelled",
    )
    .action(async (options: ReportOptions) => {
      const refuse = (message: string): void => {
        input.stderr(`kanthord: invalid-request: ${message}\n`);
        input.fail();
      };
      if (options.id === undefined) {
        refuse("--id is required");
        return;
      }
      const fence = Number(options.fence ?? "");
      if (
        !/^[1-9][0-9]*$/.test(options.fence ?? "") ||
        !Number.isSafeInteger(fence)
      ) {
        refuse("--fence must be a positive integer");
        return;
      }
      if (options.outcome === undefined) {
        refuse("--outcome is required");
        return;
      }
      if (!isTaskReportOutcome(options.outcome)) {
        refuse("--outcome must be accepted, rejected, failed or cancelled");
        return;
      }
      if (options.outcome === "accepted") {
        if (options.objectId === undefined) {
          refuse("--object-id is required for --outcome accepted");
          return;
        }
        if (!objectId.safeParse(options.objectId).success) {
          refuse(
            "--object-id must be 40 or 64 lowercase hexadecimal characters",
          );
          return;
        }
        if (options.reason !== undefined) {
          refuse("--reason is not valid for --outcome accepted");
          return;
        }
      } else if (
        options.outcome === "rejected" ||
        options.outcome === "failed"
      ) {
        if (options.reason === undefined || options.reason.length === 0) {
          refuse(`--reason is required for --outcome ${options.outcome}`);
          return;
        }
      } else if (options.reason !== undefined && options.reason.length === 0) {
        refuse("--reason is required for --outcome cancelled");
        return;
      }
      if (options.outcome !== "accepted" && options.objectId !== undefined) {
        refuse(`--object-id is not valid for --outcome ${options.outcome}`);
        return;
      }
      const body: Readonly<Record<string, unknown>> =
        options.outcome === "accepted"
          ? { report: options.outcome, fence, objectId: options.objectId }
          : {
              report: options.outcome,
              fence,
              ...(options.reason !== undefined
                ? { reason: options.reason }
                : {}),
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
