import type { Command } from "commander";

import {
  CliError,
  printRefusal,
  requireLoopbackBaseUrl,
  resolveClientOptions,
} from "../options.ts";
import { dbCommand } from "./index.ts";

export type AppliedMigrationLine = Readonly<{
  version: number;
  name: string;
}>;

export type MigrateHandler = (
  input: Readonly<{ home: string | undefined; config: string | undefined }>,
) => readonly AppliedMigrationLine[];

export type RegisterDbMigrateInput = Readonly<{
  program: Command;
  migrate: MigrateHandler;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerDbMigrate(input: RegisterDbMigrateInput): void {
  dbCommand(input.program)
    .command("migrate")
    .description("apply every pending migration to the daemon database")
    .option("--home <path>", "override the configured daemon home")
    .action((options) => {
      try {
        requireLoopbackBaseUrl(
          resolveClientOptions({ program: input.program, env: input.env }),
        );
      } catch (error) {
        if (error instanceof CliError) {
          printRefusal(error, input.stderr);
          input.fail();
          return;
        }
        throw error;
      }

      const applied = input.migrate({
        home: options.home ?? input.program.opts().home,
        config: input.program.opts().config,
      });
      if (applied.length === 0) {
        input.stdout("kanthord: no change\n");
        return;
      }
      for (const entry of applied) {
        input.stdout(`kanthord: applied ${entry.version} ${entry.name}\n`);
      }
    });
}
