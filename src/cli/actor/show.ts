import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { actorShowResponse } from "../../http/contract/actor.ts";
import { actorCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type ShowActorInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

export function registerActorShow(input: ShowActorInput): void {
  actorCommand(input.program)
    .command("show")
    .description("show one actor")
    .option("--id <id>", "actor id")
    .action(async (options: { id?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("actor.show", undefined, {
        id: options.id,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }
      const view = actorShowResponse.parse(result.body);
      const revoked = view.revokedAt !== null ? " revoked" : "";
      input.stdout(`${view.id} ${view.name} ${view.kind}${revoked}\n`);
    });
}
