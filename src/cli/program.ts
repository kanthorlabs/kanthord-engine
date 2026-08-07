import { Command } from "commander";

import { call, type ClientDependencies, type DaemonClient } from "./client.ts";
import type { ConfirmDependencies } from "./confirm.ts";
import { registerCredentialRegister } from "./credential/register.ts";
import type { AppliedMigrationLine } from "./db/migrate.ts";
import { registerDbMigrate } from "./db/migrate.ts";
import { registerDbStatus } from "./db/status.ts";
import { KANTHORD_VERSION } from "../domain/version.ts";
import {
  registerClientOptions,
  requireBaseUrl,
  resolveClientOptions,
} from "./options.ts";
import type { PlanDirectoryDependencies } from "./plan/directory.ts";
import { registerPlanExport } from "./plan/export.ts";
import { registerPlanImport } from "./plan/import.ts";
import { registerProjectCreate } from "./project/create.ts";
import { registerProjectList } from "./project/list.ts";
import { registerProjectShow } from "./project/show.ts";
import { registerProjectRepository } from "./project/repository.ts";
import { registerRepositoryRegister } from "./repository/register.ts";
import { registerRepositoryShow } from "./repository/show.ts";
import { registerRun } from "./run.ts";
import { registerStatus } from "./status.ts";

export type ServeOptions = Readonly<{
  config: string | undefined;
  home: string | undefined;
}>;

export type ProgramDependencies = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
  confirm: ConfirmDependencies;
  readFile: (path: string) => string;
  fs: PlanDirectoryDependencies;
  migrate: (
    input: Readonly<{ home: string | undefined; config: string | undefined }>,
  ) => readonly AppliedMigrationLine[];
  serve: (options: ServeOptions) => Promise<void>;
}>;

export function buildProgram(dependencies: ProgramDependencies): Command {
  const program = new Command()
    .name("kanthord")
    .version(KANTHORD_VERSION)
    .option("--config <path>", "path to the configuration file")
    .option("--home <path>", "override the configured daemon home");

  registerClientOptions(program);

  program
    .command("serve")
    .description("run the daemon")
    .action(async () => {
      const options = program.opts();
      await dependencies.serve({ config: options.config, home: options.home });
    });

  const clientFactory = (): ClientDependencies => {
    const options = resolveClientOptions({ program, env: dependencies.env });
    return {
      baseUrl: requireBaseUrl(options),
      token: options.token,
      fetch: dependencies.fetch,
    };
  };
  const client: DaemonClient = {
    call: (operationId, body, parameters) =>
      call(clientFactory(), { operationId, body, parameters }),
  };

  registerDbMigrate({
    program,
    env: dependencies.env,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
    migrate: dependencies.migrate,
  });
  registerDbStatus({
    program,
    client: clientFactory,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    exit: dependencies.exit,
  });
  registerCredentialRegister({
    program,
    client,
    env: dependencies.env,
    confirm: dependencies.confirm,
    readFile: dependencies.readFile,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerRepositoryRegister({
    program,
    client,
    env: dependencies.env,
    confirm: dependencies.confirm,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerRepositoryShow({
    program,
    client,
    env: dependencies.env,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerStatus({
    program,
    client,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerRun({
    program,
    client,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    exit: dependencies.exit,
  });
  registerProjectCreate({
    program,
    client,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerProjectList({
    program,
    client,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerProjectShow({
    program,
    client,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerProjectRepository({
    program,
    client,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerPlanImport({
    program,
    client,
    confirm: dependencies.confirm,
    cwd: dependencies.cwd,
    fs: dependencies.fs,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });
  registerPlanExport({
    program,
    client,
    cwd: dependencies.cwd,
    fs: dependencies.fs,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    fail: dependencies.fail,
  });

  return program;
}
