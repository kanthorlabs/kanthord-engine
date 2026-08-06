import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { planExportResponse } from "../../http/contract/graph.ts";
import type { PlanDirectoryDependencies } from "./directory.ts";
import { writePlanDirectory } from "./directory.ts";
import { planCommand } from "./index.ts";

export type PlanExportCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  cwd: string;
  fs: PlanDirectoryDependencies;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerPlanExport(input: PlanExportCliInput): void {
  const group = planCommand(input.program);
  if (group.commands.some((command) => command.name() === "export")) {
    return;
  }
  group
    .command("export")
    .description("export the accepted plan documents")
    .option("--project <id>", "project id")
    .option("--directory <path>", "directory to write into")
    .action(async (options: { project?: string; directory?: string }) => {
      if (options.project === undefined) {
        input.stderr("kanthord: invalid-request: --project is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("plan.export", undefined, {
        id: options.project,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }
      const body = planExportResponse.parse(result.body);
      const removed = writePlanDirectory(input.fs, {
        root: options.directory ?? input.cwd,
        documents: body.documents,
      });
      input.stdout(`kanthord: revision ${body.revision ?? "<none>"}\n`);
      input.stdout(`kanthord: wrote ${body.documents.length} document\n`);
      input.stdout(`kanthord: removed ${removed.length} document\n`);
    });
}
