import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeClaimResponse } from "../../http/contract/execution.ts";
import { nodeCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type NodeClaimCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
  randomBytes: (size: number) => Buffer;
}>;

type ClaimOptions = Readonly<{ id?: string }>;

export function registerNodeClaim(input: NodeClaimCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "claim")) {
    return;
  }
  group
    .command("claim")
    .description("claim a node for execution")
    .option("--id <id>", "node id")
    .action(async (options: ClaimOptions) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const id = options.id;
      const idempotencyKey = input.randomBytes(16).toString("hex");
      const result = await input.client.call(
        "node.claim",
        {},
        { id },
        { idempotencyKey },
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
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
