import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import {
  nodeDeleteResponse,
  nodeShowResponse,
  planRevisionsResponse,
} from "../../http/contract/graph.ts";
import { exitCodeForError } from "../exit-code.ts";
import { nodeCommand } from "./index.ts";

export type NodeDeleteCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

export function registerNodeDelete(input: NodeDeleteCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "delete")) {
    return;
  }
  group
    .command("delete")
    .description("delete a node")
    .option("--id <id>", "node id")
    .action(async (options: { id?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const showResult = await input.client.call("node.show", undefined, {
        id: options.id,
      });
      if (!showResult.ok) {
        input.stderr(`kanthord: ${showResult.code}: ${showResult.message}\n`);
        input.exit(exitCodeForError(showResult.code, showResult.status));
        return;
      }
      const show = nodeShowResponse.parse(showResult.body);
      const revisionsResult = await input.client.call(
        "plan.revisions",
        undefined,
        { id: show.projectId },
      );
      if (!revisionsResult.ok) {
        input.stderr(
          `kanthord: ${revisionsResult.code}: ${revisionsResult.message}\n`,
        );
        input.exit(
          exitCodeForError(revisionsResult.code, revisionsResult.status),
        );
        return;
      }
      const revisionsBody = planRevisionsResponse.parse(revisionsResult.body);
      const deleteResult = await input.client.call(
        "node.delete",
        {
          fromRevision: revisionsBody.revisions[0]?.id ?? null,
        },
        { id: options.id },
      );
      if (!deleteResult.ok) {
        input.stderr(
          `kanthord: ${deleteResult.code}: ${deleteResult.message}\n`,
        );
        input.exit(exitCodeForError(deleteResult.code, deleteResult.status));
        return;
      }
      const body = nodeDeleteResponse.parse(deleteResult.body);
      for (const deleted of body.deleted) {
        input.stdout(`${deleted}\n`);
      }
      for (const finding of body.completeness) {
        input.stderr(
          `kanthord: completeness: ${finding.code} ${finding.message}\n`,
        );
      }
    });
}
