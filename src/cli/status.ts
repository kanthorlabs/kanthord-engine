import type { Command } from "commander";

import type { DaemonClient } from "./client.ts";
import { systemStatusResponse } from "../http/contract/system.ts";
import { projectStatusResponse } from "../http/contract/project.ts";
import { exitCodeForError } from "./exit-code.ts";

export type StatusCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

function renderNodeLines(
  input: StatusCliInput,
  nodes: readonly Readonly<{
    kind: string;
    state: string;
    blockReason: string | null;
    count: number;
  }>[],
): void {
  if (nodes.length === 0) {
    input.stdout("kanthord: no node\n");
    return;
  }
  for (const node of nodes) {
    input.stdout(
      `kanthord: node ${node.kind} ${node.state} ${node.blockReason ?? "-"} ${node.count}\n`,
    );
  }
}

export function registerStatus(input: StatusCliInput): void {
  input.program
    .command("status")
    .description("report the daemon status")
    .option("--project <id>", "report one project's node counts")
    .action(async (options: Readonly<{ project?: string }>) => {
      if (options.project !== undefined) {
        const result = await input.client.call("project.status", undefined, {
          id: options.project,
        });
        if (!result.ok) {
          input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
          input.exit(exitCodeForError(result.code, result.status));
          return;
        }
        const status = projectStatusResponse.parse(result.body);
        renderNodeLines(input, status.nodes);
        return;
      }

      const result = await input.client.call("system.status", undefined);
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }

      const status = systemStatusResponse.parse(result.body);
      input.stdout(`kanthord: version ${status.version}\n`);
      input.stdout(`kanthord: bind ${status.bind}\n`);
      input.stdout(`kanthord: started ${status.startedAt}\n`);
      input.stdout(`kanthord: health ${status.status}\n`);
      if (status.dependencies.length === 0) {
        input.stdout("kanthord: no dependency\n");
      } else {
        for (const dependency of status.dependencies) {
          input.stdout(
            `kanthord: dependency ${dependency.name} ${dependency.status}\n`,
          );
        }
      }
      renderNodeLines(input, status.nodes);
      if (status.repositories.length === 0) {
        input.stdout("kanthord: no repository needs reconcile\n");
      } else {
        for (const repository of status.repositories) {
          input.stdout(
            `kanthord: repository ${repository.id} ${repository.name} ${repository.divergedLandingOid} ${repository.divergedUpstreamOid}\n`,
          );
        }
      }
      if (status.leases.length === 0) {
        input.stdout("kanthord: no expired lease\n");
      } else {
        for (const lease of status.leases) {
          input.stdout(
            `kanthord: lease ${lease.subjectKind} ${lease.subjectId} ${lease.owner ?? "-"} ${lease.fence} ${lease.expiresAt}\n`,
          );
        }
      }
    });
}
