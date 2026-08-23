import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeListResponse } from "../../http/contract/graph.ts";
import { nodeCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type NodeListCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

type ListOptions = Readonly<{
  project?: string;
  kind?: string;
  state?: string;
  blockReason?: string;
  repository?: string;
}>;

export function registerNodeList(input: NodeListCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "list")) {
    return;
  }
  group
    .command("list")
    .description("list nodes")
    .option("--project <id>", "project id")
    .option("--kind <kind>", "node kind")
    .option("--state <state>", "node state")
    .option("--block-reason <reason>", "block reason")
    .option("--repository <id>", "repository id")
    .action(async (options: ListOptions) => {
      const query: Readonly<Record<string, string | undefined>> = {
        project: options.project,
        kind: options.kind,
        state: options.state,
        blockReason: options.blockReason,
        repository: options.repository,
      };
      const present = Object.entries(query).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      );
      const callOptions =
        present.length === 0
          ? undefined
          : { query: Object.fromEntries(present) };
      const result = await input.client.call(
        "node.list",
        undefined,
        undefined,
        callOptions,
      );
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
          `kanthord: node ${node.id} ${node.kind} ${node.state} ${node.blockReason ?? "-"} ${node.parentId ?? "-"}\n`,
        );
      }
    });
}
