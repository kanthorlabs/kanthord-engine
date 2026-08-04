import type { Command } from "commander";

import { CliError, printRefusal } from "../options.ts";
import type { ClientDependencies } from "../client.ts";
import { call } from "../client.ts";
import { exitCodeForError } from "../exit-code.ts";
import { systemDbResponse } from "../../http/contract/system.ts";
import { dbCommand } from "./index.ts";

export type RegisterDbStatusInput = Readonly<{
  program: Command;
  client: () => ClientDependencies;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
}>;

export function registerDbStatus(input: RegisterDbStatusInput): void {
  dbCommand(input.program)
    .command("status")
    .description("report the migration state of the daemon database")
    .action(async () => {
      let client: ClientDependencies;
      try {
        client = input.client();
      } catch (error) {
        if (error instanceof CliError) {
          printRefusal(error, input.stderr);
          input.exit(1);
          return;
        }
        throw error;
      }

      const result = await call(client, { operationId: "system.db" });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }

      const parsed = systemDbResponse.parse(result.body);
      for (const migration of parsed.migrations) {
        input.stdout(
          `${migration.name} ${migration.applied ? "applied" : "pending"}\n`,
        );
      }
    });
}
