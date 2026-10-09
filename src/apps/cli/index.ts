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
import { writePrivate } from "../../kernel/files.ts";
import { Diagnostic, diagnostic } from "../../kernel/errors.ts";
import type { Server } from "../server/index.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { packageVersion } from "../../kernel/version.ts";
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
import { addIntakeCommand } from "./intake.ts";
import { addSchedulerCommand } from "./scheduler.ts";
import {
  CommandName,
  ExitCode,
  PROGRAM_NAME,
  SERVER_APPLICATION,
} from "./constants.ts";

const HOST_PROBE_SCHEME = "http://";
const HOST_PROBE_DEFAULT_PORT = ":80";

function allowedHost(value: string): string {
  const host = value.toLowerCase();
  const parsed = URL.parse(`${HOST_PROBE_SCHEME}${host}`);
  if (
    parsed &&
    (parsed.host === host ||
      `${parsed.host}${HOST_PROBE_DEFAULT_PORT}` === host)
  )
    return host;
  throw new Diagnostic(
    "cli.config.invalid_allowed_host",
    "config init: --gateway-allowed-host expects <name> or <name>:<port>.",
  );
}

function collectHost(value: string, hosts: string[] | undefined): string[] {
  return [...(hosts ?? []), value];
}

export async function initConfig(
  path: string,
  allowedHosts: readonly string[] = [],
  bind?: string,
  basePath?: string,
): Promise<void> {
  const { initialConfig } = await import("../../config/index.ts");
  const content = initialConfig(allowedHosts.map(allowedHost), bind, basePath);
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
  const init = config
    .command("init")
    .description("Create a private configuration file without prompting")
    .option(
      "--gateway-allowed-host <host>",
      "Append a host to gateway.allowed_hosts (repeatable)",
      collectHost,
    )
    .option("--gateway-bind <address>", "Set gateway.bind to this IP address")
    .option(
      "--gateway-base-path <path>",
      "Set gateway.base_path to this path prefix",
    );
  configHelp(init);
  init.action(() => {
    const options = init.opts<{
      gatewayAllowedHost?: string[];
      gatewayBind?: string;
      gatewayBasePath?: string;
    }>();
    return initConfig(
      effectivePath(init),
      options.gatewayAllowedHost,
      options.gatewayBind,
      options.gatewayBasePath,
    );
  });
  for (const [name, description, action] of [
    [
      "validate",
      "Validate the stored configuration",
      async (path: string) => {
        const { loadConfig } = await import("../../config/index.ts");
        loadConfig(path);
        process.stdout.write(`Valid configuration: ${path}\n`);
      },
    ],
    [
      "show",
      "Show effective configuration with secrets masked",
      async (path: string) => {
        const { showConfig } = await import("../../config/index.ts");
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

async function serveWorker(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  if (options.config !== undefined)
    throw new Diagnostic(
      "cli.serve.worker_config",
      "serve worker: --config is not supported; use client options or cli.yaml.",
    );
  const { runWorker } = await import("../worker/index.ts");
  const error = await runWorker(options);
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
    .command(CommandName.Serve)
    .argument("[application]", "Application to start: server or worker")
    .description("Start an application (default: server)")
    .option("--config <path>", "YAML configuration file")
    .action((application: string | undefined, _options, command: Command) =>
      serveServer(application, command, onServer),
    );
  serve
    .command(CommandName.Worker)
    .description(
      "Start the worker application: register, pull and execute work",
    )
    .option("--endpoint <url>", "Server endpoint")
    .option(
      "--token <jwt>",
      "Machine JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
    )
    .action((_options, command: Command) => serveWorker(command));
}

export function createProgram(
  onServer: (server: Server) => void = () => {},
): Command {
  const program = new Command()
    .name(PROGRAM_NAME)
    .description("kanthord work orchestration server and CLI");
  program.option("--verbose", "Show verbose output", false);
  program.version(
    packageVersion(),
    "-V, --version",
    "Print the package version",
  );
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
  addIntakeCommand(program);
  for (const name of [CommandName.Tracking]) {
    const group = program
      .command(name)
      .description(
        `${name[0]!.toUpperCase()}${name.slice(1)} Service commands (not implemented)`,
      )
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
    .option("--token <jwt>", "Human JWT (otherwise KANTHORD_TOKEN or cli.yaml)")
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
    .action(writePackageOpenAPI);
}

async function writePackageOpenAPI(): Promise<void> {
  const { openapiPath, writeOpenAPI } = await import("../../gateway/local.ts");
  const path = openapiPath();
  writeOpenAPI(apiOperations, dirname(path));
  process.stdout.write(`${path}\n`);
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
