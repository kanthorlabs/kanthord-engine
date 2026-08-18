import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeHeartbeatResponse } from "../../http/contract/execution.ts";
import { nodeCommand } from "./index.ts";

export type NodeHeartbeatCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  randomBytes: (size: number) => Buffer;
}>;

type HeartbeatOptions = Readonly<{ id?: string; fence?: string }>;

export function registerNodeHeartbeat(input: NodeHeartbeatCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "heartbeat")) {
    return;
  }
  group
    .command("heartbeat")
    .description("renew the lease of a node")
    .option("--id <id>", "node id")
    .requiredOption("--fence <n>", "lease fence")
    .action(async (options: HeartbeatOptions) => {
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
      const idempotencyKey = input.randomBytes(16).toString("hex");
      const result = await input.client.call(
        "node.heartbeat",
        { fence },
        { id },
        { idempotencyKey },
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const body = nodeHeartbeatResponse.parse(result.body);
      input.stdout(
        `kanthord: renewed ${id} fence ${body.lease.fence} expires ${body.lease.expiresAt}\n`,
      );
    });
}
