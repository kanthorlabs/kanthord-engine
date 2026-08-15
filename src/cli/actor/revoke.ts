import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { actorShowResponse } from "../../http/contract/actor.ts";
import { actorCommand } from "./index.ts";

export type RevokeActorInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerActorRevoke(input: RevokeActorInput): void {
  actorCommand(input.program)
    .command("revoke")
    .description("revoke an actor and fence its leases")
    .option("--id <id>", "actor id")
    .action(async (options: { id?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("actor.revoke", undefined, {
        id: options.id,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }
      const view = actorShowResponse.parse(result.body);
      input.stdout(`${view.id} ${view.name} ${view.kind}\n`);
    });
}
