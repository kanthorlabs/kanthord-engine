import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeClaimResponse } from "../../http/contract/execution.ts";
import { nodeCommand } from "./index.ts";

export type NodeClaimCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  randomBytes: (size: number) => Buffer;
}>;

export function registerNodeClaim(input: NodeClaimCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "claim")) {
    return;
  }
  group
    .command("claim")
    .description("claim a node for execution")
    .argument("<id>", "node id")
    .action(async (id: string) => {
      const idempotencyKey = input.randomBytes(16).toString("hex");
      const result = await input.client.call(
        "node.claim",
        {},
        { id },
        { idempotencyKey },
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const body = nodeClaimResponse.parse(result.body);
      input.stdout(
        `kanthord: claimed ${id} fence ${body.lease.fence} expires ${body.lease.expiresAt} heartbeat ${body.heartbeatIntervalMs}ms\n`,
      );
      input.stdout(
        `kanthord: run ${body.runId} attempt ${body.attemptNo ?? "-"} objective-run ${body.objectiveRunId} objective-fence ${body.objectiveLease.fence}\n`,
      );
    });
}
