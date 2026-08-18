import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeReleaseResponse } from "../../http/contract/execution.ts";
import { nodeCommand } from "./index.ts";

export type NodeReleaseCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

type ReleaseOptions = Readonly<{ id?: string; fence?: string }>;

export function registerNodeRelease(input: NodeReleaseCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "release")) {
    return;
  }
  group
    .command("release")
    .description("release the lease of a node")
    .option("--id <id>", "node id")
    .requiredOption("--fence <n>", "lease fence")
    .action(async (options: ReleaseOptions) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const id = options.id;
      const fence = Number.parseInt(options.fence ?? "", 10);
      if (!Number.isInteger(fence) || fence < 1) {
        input.stderr(
          "kanthord: invalid-request: --fence must be a positive integer\n",
        );
        input.fail();
        return;
      }
      const result = await input.client.call("node.release", { fence }, { id });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const body = nodeReleaseResponse.parse(result.body);
      input.stdout(`kanthord: released ${id} state ${body.node.state}\n`);
    });
}
