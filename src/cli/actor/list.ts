import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { actorListResponse } from "../../http/contract/actor.ts";
import { actorCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type ListActorInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

export function registerActorList(input: ListActorInput): void {
  actorCommand(input.program)
    .command("list")
    .description("list every actor")
    .action(async () => {
      const result = await input.client.call("actor.list", undefined);
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }
      const parsed = actorListResponse.parse(result.body);
      for (const view of parsed.actors) {
        const revoked = view.revokedAt !== null ? " revoked" : "";
        input.stdout(`${view.id} ${view.name} ${view.kind}${revoked}\n`);
      }
    });
}
