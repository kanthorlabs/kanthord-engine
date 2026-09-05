import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { nodeRenewResponse } from "../../http/contract/execution.ts";
import { nodeCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type NodeRenewCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
  randomBytes: (size: number) => Buffer;
}>;

type RenewOptions = Readonly<{
  id?: string;
  fence?: string;
  runId?: string;
  runFence?: string;
}>;

export function registerNodeRenew(input: NodeRenewCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "renew")) {
    return;
  }
  group
    .command("renew")
    .description("renew the lease of a node")
    .option("--id <id>", "node id")
    .requiredOption("--fence <n>", "lease fence")
    .requiredOption("--run-id <id>", "run id")
    .requiredOption("--run-fence <n>", "run fence")
    .action(async (options: RenewOptions) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const id = options.id;
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
      const runId = options.runId;
      if (runId === undefined) {
        input.stderr("kanthord: invalid-request: --run-id is required\n");
        input.fail();
        return;
      }
      const runFence = Number(options.runFence ?? "");
      if (
        !/^[1-9][0-9]*$/.test(options.runFence ?? "") ||
        !Number.isSafeInteger(runFence)
      ) {
        input.stderr(
          "kanthord: invalid-request: --run-fence must be a positive integer\n",
        );
        input.fail();
        return;
      }
      const idempotencyKey = input.randomBytes(16).toString("hex");
      const result = await input.client.call(
        "node.renew",
        { fence, runId, runFence },
        { id },
        { idempotencyKey },
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }

      const body = nodeRenewResponse.parse(result.body);
      input.stdout(
        `kanthord: renewed ${id} fence ${body.lease.fence} expires ${body.lease.expiresAt}\n`,
      );
    });
}
