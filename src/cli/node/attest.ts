import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeCommand } from "./index.ts";
import { printNodeReportView } from "./report-view.ts";

export type NodeAttestCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

type AttestOptions = Readonly<{
  id?: string;
  fence?: string;
  objectId?: string;
}>;

export function registerNodeAttest(input: NodeAttestCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "attest")) {
    return;
  }
  group
    .command("attest")
    .description("attest the combined object id of an objective")
    .option("--id <id>", "node id")
    .option("--fence <n>", "lease fence")
    .option("--object-id <oid>", "attested object id")
    .action(async (options: AttestOptions) => {
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
      const result = await input.client.call(
        "node.report",
        { report: "attested", fence, objectId: options.objectId },
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
