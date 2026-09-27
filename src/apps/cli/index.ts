import { workerOperations } from "../../worker/contract.ts";
import { custodyOperations } from "../../custody/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import assert from "node:assert/strict";
import { Command, CommanderError } from "commander";
import { dirname } from "node:path";
import {
  configPath,
  initialConfig,
  loadConfig,
  showConfig,
} from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { Diagnostic, diagnostic } from "../../kernel/errors.ts";
import { Server } from "../server/index.ts";
import { runWorker } from "../worker/index.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { openapiPath } from "../../gateway/local.ts";
import { writeOpenAPI } from "../../gateway/local.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  generateHumanJWT,
  generateMachineJWT,
  parseHumanUsername,
  parseDisplayName,
  parseWorkerBinding,
  requireTokenTerminal,
} from "../../gateway/local.ts";
import { KANTHORD_AUTH_USERNAME } from "../../gateway/local.ts";
import { resolveClient } from "../../gateway/client.ts";
import { addWorkerCommand } from "./worker.ts";
import { addCredentialCommand } from "./credential.ts";
import { addSchedulerCommand } from "./scheduler.ts";
import {
  CommandName,
  ExitCode,
  PROGRAM_NAME,
  SERVER_APPLICATION,
} from "./constants.ts";

function effectivePath(command: Command): string {
  return configPath(command.optsWithGlobals().config as string | undefined);
}
function configHelp(command: Command): void {
  command.addHelpText(
    "after",
    () => `\nConfiguration file: ${effectivePath(command)}`,
  );
}

export async function initConfig(path: string): Promise<void> {
  const content = initialConfig();
  writePrivate(path, content);
  process.stdout.write(`Created ${path}\n`);
}

function addConfigCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Config),
  );
  const config = program
    .command(CommandName.Config)
    .description("Create, validate, or show server configuration")
    .option("--config <path>", "YAML configuration file");
  configHelp(config);
  config.action(() => config.help());
  for (const [name, description, action] of [
    [
      "init",
      "Create a private configuration file without prompting",
      (path: string) => initConfig(path),
    ],
    [
      "validate",
      "Validate the stored configuration",
      (path: string) => {
        loadConfig(path);
        process.stdout.write(`Valid configuration: ${path}\n`);
      },
    ],
    [
      "show",
      "Show effective configuration with secrets masked",
      (path: string) => {
        process.stdout.write(showConfig(path));
      },
    ],
  ] as const) {
    const command = config.command(name).description(description);
    configHelp(command);
    command.action(() => action(effectivePath(command)));
  }
}

function addServeCommand(
  program: Command,
  onServer: (server: Server) => void,
): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Serve),
  );
  const serve = program
    .command(`${CommandName.Serve} [application]`)
    .description("Start an application (default: server)")
    .option("--config <path>", "YAML configuration file")
    .action(
      async (application: string | undefined, _options, command: Command) => {
        if (application !== undefined && application !== SERVER_APPLICATION)
          throw new Diagnostic(
            "cli.serve.unsupported_application",
            "serve: supported applications are server and worker.",
          );
        const server = new Server(effectivePath(command));
        onServer(server);
        const error = await server.run();
        if (error) throw error;
      },
    );
  serve
    .command(CommandName.Worker)
    .description(
      "Start the worker application after checking the server version",
    )
    .option("--endpoint <url>", "Server endpoint")
    .option(
      "--token <jwt>",
      "Machine JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
    )
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals();
      if (options.config !== undefined)
        throw new Diagnostic(
          "cli.serve.worker_config",
          "serve worker: --config is not supported; use client options or cli.yaml.",
        );
      const error = await runWorker(options);
      if (error) throw error;
    });
}

export function createProgram(
  onServer: (server: Server) => void = () => {},
): Command {
  const program = new Command()
    .name(PROGRAM_NAME)
    .description("kanthord work orchestration server and CLI");
  program.exitOverride();
  program.allowExcessArguments(false);
  program.configureHelp({ showGlobalOptions: true });
  program.action(() => {
    program.outputHelp();
    throw new CommanderError(
      ExitCode.Failure,
      "cli.command.required",
      "A command is required.",
    );
  });
  addConfigCommand(program);
  addServeCommand(program, onServer);
  addJWTCommand(program);
  addCredentialCommand(program);
  addSchedulerCommand(program);
  for (const name of [
    CommandName.Project,
    CommandName.Mission,
    CommandName.Tracking,
  ]) {
    const group = program
      .command(name)
      .description(`${name[0]!.toUpperCase()}${name.slice(1)} Service commands`)
      .option("--endpoint <url>", "Server endpoint");
    group.action(() => group.help());
  }
  addWorkerCommand(program);
  addGatewayCommand(program);
  const names = program.commands.map((command) => command.name());
  assert.equal(names.length, Object.keys(CommandName).length);
  assert.equal(new Set(names).size, names.length);
  return program;
}

function addJWTCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.JWT),
  );
  const jwt = program
    .command(CommandName.JWT)
    .description("Generate a human or machine JWT locally")
    .argument(
      "[username]",
      `Human username (nonblank, 1–64 characters; default: ${KANTHORD_AUTH_USERNAME})`,
      parseHumanUsername,
    )
    .option(
      "--name <display>",
      "Display name (nonblank, 1–64 characters; defaults to subject)",
      parseDisplayName,
    )
    .option(
      "--binding <worker binding>",
      "Issue a machine JWT (nonblank binding, 1–128 characters; no username)",
      parseWorkerBinding,
    )
    .option("--config <path>", "YAML server configuration file")
    .action(
      async (
        username: string | undefined,
        options: { name?: string; binding?: string },
        command: Command,
      ) => {
        if (options.binding !== undefined && username !== undefined)
          throw new Diagnostic(
            "cli.jwt.username_with_binding",
            "jwt: a username cannot be combined with --binding.",
          );
        requireTokenTerminal(process.stdout);
        const config = loadConfig(effectivePath(command));
        const { token } =
          options.binding === undefined
            ? await generateHumanJWT(
                config.masterKey,
                config.gateway.tokenLifetime,
                username,
                options.name,
              )
            : await generateMachineJWT(
                config.masterKey,
                config.gateway.tokenLifetime,
                options.binding,
                options.name,
              );
        process.stdout.write(`${token}\n`);
      },
    );
  configHelp(jwt);
}

function addGatewayCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Gateway),
  );
  const gateway = program
    .command(CommandName.Gateway)
    .description("Gateway Service commands")
    .option("--endpoint <url>", "Server endpoint");
  gateway.action(() => gateway.help());
  gateway
    .command("verify")
    .description("Verify a human JWT through the server and print its identity")
    .option(
      "--token <jwt>",
      "Human JWT (otherwise KANTHORD_TOKEN or an operator-supplied client file)",
    )
    .action(async (_options, command: Command) => {
      const config = resolveClient(command.optsWithGlobals());
      const result = await httpClient(
        gatewayOperations,
        config.endpoint,
        config.token,
      ).verify({ params: {}, query: {}, body: null });
      if (result.type === OperationResultType.Indeterminate)
        throw new Diagnostic(
          "cli.gateway.verify.indeterminate",
          "gateway verify: result is indeterminate; the server could not be verified.",
        );
      if (result.type === OperationResultType.Failure)
        throw new Diagnostic(
          result.error.error.code,
          `gateway verify: request failed (HTTP ${result.status}).`,
        );
      process.stdout.write(`${JSON.stringify(result.data)}\n`);
    });
  gateway
    .command("openapi")
    .description("Emit the package OpenAPI contract locally")
    .action(() => {
      const path = openapiPath();
      writeOpenAPI(apiOperations, dirname(path));
      process.stdout.write(`${path}\n`);
    });
}

export async function runCLI(
  args: string[],
  onServer?: (server: Server) => void,
): Promise<number> {
  process.umask(0o077);
  try {
    await createProgram(onServer).parseAsync(args);
    return ExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    process.stderr.write(`${diagnostic(error)}\n`);
    return ExitCode.Failure;
  }
}

const apiOperations = [
  ...Object.values(gatewayOperations),
  ...Object.values(custodyOperations),
  ...Object.values(workerOperations),
  ...Object.values(schedulerOperations),
  projectOperations.create,
  projectOperations.list,
  projectOperations.get,
  projectOperations.rename,
];
