import type { Command } from "commander";

import { isLoopbackUrl } from "../base-url.ts";

export type AppliedMigrationLine = Readonly<{
  version: number;
  name: string;
}>;

export type MigrateHandler = (
  input: Readonly<{ home: string | undefined }>,
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
  input.program
    .command("db")
    .description("database maintenance")
    .command("migrate")
    .description("apply every pending migration to the daemon database")
    .option("--home <path>", "override the configured daemon home")
    .option(
      "--base-url <url>",
      "daemon base url; a non-loopback url is refused",
    )
    .action((options) => {
      const baseUrl: string | undefined =
        options.baseUrl ?? input.env.KANTHORD_BASE_URL;
      if (
        baseUrl !== undefined &&
        baseUrl.length > 0 &&
        !isLoopbackUrl(baseUrl)
      ) {
        input.stderr(
          `kanthord: db-remote-base-url: ${baseUrl} is not a loopback daemon; db migrate opens the database file on the daemon machine\n`,
        );
        input.fail();
        return;
      }

      const applied = input.migrate({
        home: options.home ?? input.program.opts().home,
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
