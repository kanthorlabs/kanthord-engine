import { workerOperations } from "../../worker/contract.ts";
import { agentOperations } from "../../agent/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import { storageOperations } from "../../storage/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { missionOperations } from "../../mission/contract.ts";
import { workbenchOperations } from "../../workbench/contract.ts";
import { intakeOperations } from "../../intake/contract.ts";
import assert from "node:assert/strict";
import { Command, CommanderError } from "commander";
import { dirname } from "node:path";
import { initialConfig, loadConfig, showConfig } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { Diagnostic, diagnostic } from "../../kernel/errors.ts";
import type { Server } from "../server/index.ts";
import { runWorker } from "../worker/index.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { openapiPath } from "../../gateway/local.ts";
import { writeOpenAPI } from "../../gateway/local.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { resolveClient } from "../../gateway/client.ts";
import { addWorkerCommand } from "./worker.ts";
import { addAgentCommand } from "./agent.ts";
import { addJWTCommand } from "./jwt.ts";
import { configHelp, effectivePath } from "./config-path.ts";
import { addLlmCommand } from "./llm.ts";
import { addRepositoryCommand } from "./repository.ts";
import { addStorageCommand } from "./storage.ts";
import { addProjectCommand } from "./project.ts";
import { addMissionCommand } from "./mission.ts";
import { addSchedulerCommand } from "./scheduler.ts";
import {
  CommandName,
  ExitCode,
  PROGRAM_NAME,
  SERVER_APPLICATION,
} from "./constants.ts";

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

async function serveServer(
  application: string | undefined,
  command: Command,
  onServer: (server: Server) => void,
): Promise<void> {
  assert.equal(command.name(), CommandName.Serve);
  assert.equal(command.parent?.name(), PROGRAM_NAME);
  if (application !== undefined && application !== SERVER_APPLICATION)
    throw new Diagnostic(
      "cli.serve.unsupported_application",
      "serve: supported applications are server and worker.",
    );
  const { Server } = await import("../server/index.ts");
  const server = new Server(effectivePath(command));
  onServer(server);
  const error = await server.run();
  if (error) throw error;
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
    .action((application: string | undefined, _options, command: Command) =>
      serveServer(application, command, onServer),
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
  program.option("--verbose", "Show verbose output", false);
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
  addLlmCommand(program);
  addRepositoryCommand(program);
  addStorageCommand(program);
  addAgentCommand(program);
  addProjectCommand(program);
  addSchedulerCommand(program);
  addMissionCommand(program);
  for (const name of [CommandName.Tracking]) {
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
  ...Object.values(llmOperations),
  ...Object.values(repositoryOperations),
  ...Object.values(storageOperations),
  ...Object.values(agentOperations),
  ...Object.values(workerOperations),
  ...Object.values(schedulerOperations),
  ...Object.values(projectOperations),
  ...Object.values(missionOperations),
  ...Object.values(workbenchOperations),
  ...Object.values(intakeOperations),
];
const allOperationIds = apiOperations.map((operation) => operation.id);
assert.equal(
  new Set(allOperationIds).size,
  allOperationIds.length,
  "operation ID collision",
);
