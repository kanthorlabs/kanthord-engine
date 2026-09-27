import assert from "node:assert/strict";
import { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  BINDING_ID_PREFIX,
  BindingKind,
  BindingState,
  bindingSetWriteInputSchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  PROJECT_ID_PREFIX,
  projectNameSchema,
  projectOperations,
} from "../../project/contract.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const CREATE = "create";
const LIST = "list";
const GET = "get";
const RENAME = "rename";
const BINDING = "binding";
const AGENT = "agent";
const EXPORT = "export";
const APPLY = "apply";
const REVISION = "revision";
const NAME_OPTION = "--name";
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const CREATE_INVALID_NAME = "cli.project.create.invalid_name";
const RENAME_INVALID_NAME = "cli.project.rename.invalid_name";
const GET_INVALID_PROJECT_ID = "cli.project.get.invalid_project_id";
const RENAME_INVALID_PROJECT_ID = "cli.project.rename.invalid_project_id";
const CREATE_TOKEN_REQUIRED = "cli.project.create.token_required";
const LIST_TOKEN_REQUIRED = "cli.project.list.token_required";
const GET_TOKEN_REQUIRED = "cli.project.get.token_required";
const RENAME_TOKEN_REQUIRED = "cli.project.rename.token_required";
const CREATE_INDETERMINATE = "cli.project.create.indeterminate";
const LIST_INDETERMINATE = "cli.project.list.indeterminate";
const GET_INDETERMINATE = "cli.project.get.indeterminate";
const RENAME_INDETERMINATE = "cli.project.rename.indeterminate";
const BINDING_LIST_INVALID_PROJECT_ID =
  "cli.project.binding.list.invalid_project_id";
const BINDING_LIST_INVALID_KIND = "cli.project.binding.list.invalid_kind";
const BINDING_LIST_INVALID_STATE = "cli.project.binding.list.invalid_state";
const BINDING_LIST_TOKEN_REQUIRED = "cli.project.binding.list.token_required";
const BINDING_LIST_INDETERMINATE = "cli.project.binding.list.indeterminate";
const BINDING_GET_INVALID_PROJECT_ID =
  "cli.project.binding.get.invalid_project_id";
const BINDING_GET_INVALID_BINDING_ID =
  "cli.project.binding.get.invalid_binding_id";
const BINDING_GET_TOKEN_REQUIRED = "cli.project.binding.get.token_required";
const BINDING_GET_INDETERMINATE = "cli.project.binding.get.indeterminate";
const BINDING_EXPORT_INVALID_PROJECT_ID =
  "cli.project.binding.export.invalid_project_id";
const BINDING_EXPORT_TOKEN_REQUIRED =
  "cli.project.binding.export.token_required";
const BINDING_EXPORT_INDETERMINATE = "cli.project.binding.export.indeterminate";
const BINDING_APPLY_INVALID_PROJECT_ID =
  "cli.project.binding.apply.invalid_project_id";
const BINDING_APPLY_TOKEN_REQUIRED = "cli.project.binding.apply.token_required";
const BINDING_APPLY_INDETERMINATE = "cli.project.binding.apply.indeterminate";
const REVISION_LIST_INVALID_PROJECT_ID =
  "cli.project.binding.revision.list.invalid_project_id";
const REVISION_LIST_INVALID_BINDING_ID =
  "cli.project.binding.revision.list.invalid_binding_id";
const REVISION_LIST_TOKEN_REQUIRED =
  "cli.project.binding.revision.list.token_required";
const REVISION_LIST_INDETERMINATE =
  "cli.project.binding.revision.list.indeterminate";
const AGENT_LIST_INVALID_PROJECT_ID =
  "cli.project.agent.list.invalid_project_id";
const AGENT_LIST_INVALID_BINDING_ID =
  "cli.project.agent.list.invalid_binding_id";
const AGENT_LIST_TOKEN_REQUIRED = "cli.project.agent.list.token_required";
const AGENT_LIST_INDETERMINATE = "cli.project.agent.list.indeterminate";
const AGENT_GET_INVALID_PROJECT_ID = "cli.project.agent.get.invalid_project_id";
const AGENT_GET_INVALID_BINDING_ID = "cli.project.agent.get.invalid_binding_id";
const AGENT_GET_TOKEN_REQUIRED = "cli.project.agent.get.token_required";
const AGENT_GET_INDETERMINATE = "cli.project.agent.get.indeterminate";

function validateName(name: string, code: string): void {
  if (!projectNameSchema.safeParse(name).success)
    throw new Diagnostic(code, "invalid project name");
}

export function validateProjectId(id: string, code: string): void {
  if (!identitySchema(PROJECT_ID_PREFIX).safeParse(id).success)
    throw new Diagnostic(code, "invalid project ID");
}

function validateBindingId(id: string, code: string): void {
  if (!identitySchema(BINDING_ID_PREFIX).safeParse(id).success)
    throw new Diagnostic(code, "invalid binding ID");
}

function pageLimit(value: string | undefined): number {
  const limit =
    value === undefined
      ? LIST_LIMIT_DEFAULT
      : parsePositiveInt(value, LIMIT_INVALID);
  if (limit > LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${LIST_LIMIT_MAX}`,
    );
  return limit;
}

async function create(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  validateName(options.name, CREATE_INVALID_NAME);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, CREATE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(projectOperations, endpoint, token).create(
    { params: {}, query: {}, body: { name: options.name } },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, CREATE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function list(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const limit = pageLimit(options.limit);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, LIST_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token).list({
    params: {},
    query: {
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, LIST_INDETERMINATE))}\n`,
  );
}

async function get(projectId: string, command: Command): Promise<void> {
  validateProjectId(projectId, GET_INVALID_PROJECT_ID);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, GET_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token).get({
    params: { projectId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, GET_INDETERMINATE))}\n`,
  );
}

async function rename(projectId: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  validateProjectId(projectId, RENAME_INVALID_PROJECT_ID);
  validateName(options.name, RENAME_INVALID_NAME);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, RENAME_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(projectOperations, endpoint, token).rename(
    { params: { projectId }, query: {}, body: { name: options.name } },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, RENAME_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function bindingList(projectId: string, command: Command): Promise<void> {
  validateProjectId(projectId, BINDING_LIST_INVALID_PROJECT_ID);
  const options = command.optsWithGlobals();
  const kinds: string[] | undefined = options.kind;
  for (const kind of kinds ?? [])
    if (!Object.values(BindingKind).some((value) => value === kind))
      throw new Diagnostic(BINDING_LIST_INVALID_KIND, "invalid binding kind");
  const state: string | undefined = options.state;
  if (
    state !== undefined &&
    !Object.values(BindingState).some((value) => value === state)
  )
    throw new Diagnostic(BINDING_LIST_INVALID_STATE, "invalid binding state");
  const limit = pageLimit(options.limit);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, BINDING_LIST_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.list"
  ]({
    params: { projectId },
    query: {
      ...(kinds !== undefined
        ? { kind: kinds as (typeof BindingKind)[keyof typeof BindingKind][] }
        : {}),
      ...(state !== undefined
        ? { state: state as (typeof BindingState)[keyof typeof BindingState] }
        : {}),
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, BINDING_LIST_INDETERMINATE))}\n`,
  );
}

async function bindingGet(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, BINDING_GET_INVALID_PROJECT_ID);
  validateBindingId(bindingId, BINDING_GET_INVALID_BINDING_ID);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, BINDING_GET_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.get"
  ]({
    params: { projectId, bindingId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, BINDING_GET_INDETERMINATE))}\n`,
  );
}

async function bindingExport(
  projectId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, BINDING_EXPORT_INVALID_PROJECT_ID);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, BINDING_EXPORT_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "bindingSet.get"
  ]({
    params: { projectId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, BINDING_EXPORT_INDETERMINATE))}\n`,
  );
}

async function bindingApply(
  projectId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, BINDING_APPLY_INVALID_PROJECT_ID);
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, BINDING_APPLY_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, bindingSetWriteInputSchema);
  const result = await httpClient(projectOperations, endpoint, token)[
    "bindingSet.write"
  ]({ params: { projectId }, query: {}, body }, { idempotencyKey: key });
  const data = handleMutationResult(result, BINDING_APPLY_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function bindingRevisionList(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, REVISION_LIST_INVALID_PROJECT_ID);
  validateBindingId(bindingId, REVISION_LIST_INVALID_BINDING_ID);
  const options = command.optsWithGlobals();
  const limit = pageLimit(options.limit);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, REVISION_LIST_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "bindingRevision.list"
  ]({
    params: { projectId, bindingId },
    query: {
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, REVISION_LIST_INDETERMINATE))}\n`,
  );
}

async function agentList(
  projectId: string,
  workerBindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, AGENT_LIST_INVALID_PROJECT_ID);
  validateBindingId(workerBindingId, AGENT_LIST_INVALID_BINDING_ID);
  const options = command.optsWithGlobals();
  const limit = pageLimit(options.limit);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, AGENT_LIST_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "agentConfiguration.list"
  ]({
    params: { projectId, bindingId: workerBindingId },
    query: {
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, AGENT_LIST_INDETERMINATE))}\n`,
  );
}

async function agentGet(
  projectId: string,
  workerBindingId: string,
  agentName: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, AGENT_GET_INVALID_PROJECT_ID);
  validateBindingId(workerBindingId, AGENT_GET_INVALID_BINDING_ID);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, AGENT_GET_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "agentConfiguration.get"
  ]({
    params: { projectId, bindingId: workerBindingId, agentName },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, AGENT_GET_INDETERMINATE))}\n`,
  );
}

export function addProjectCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Project),
  );
  const project = program
    .command(CommandName.Project)
    .description("Project Service commands")
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "Human JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  project.action(() => project.help());
  project
    .command(CREATE)
    .description("Create a project as JSON")
    .requiredOption("--name <name>", "Project name", singleUse(NAME_OPTION))
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((_options, command: Command) => create(command));
  project
    .command(LIST)
    .description("List projects as JSON")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  project
    .command(GET)
    .description("Get a project as JSON")
    .argument("<project-id>", "Project ID")
    .action((projectId: string, _options, command: Command) =>
      get(projectId, command),
    );
  project
    .command(RENAME)
    .description("Rename a project as JSON")
    .argument("<project-id>", "Project ID")
    .requiredOption("--name <name>", "Project name", singleUse(NAME_OPTION))
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((projectId: string, _options, command: Command) =>
      rename(projectId, command),
    );
  addBindingCommands(project);
  addAgentCommands(project);
}

function addAgentCommands(project: Command): void {
  const agent = project.command(AGENT).description("Project agent commands");
  agent.action(() => agent.help());
  agent
    .command(LIST)
    .description("List worker binding agents as JSON")
    .argument("<project-id>", "Project ID")
    .argument("<worker-binding-id>", "Worker binding ID")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action(
      (
        projectId: string,
        workerBindingId: string,
        _options,
        command: Command,
      ) => agentList(projectId, workerBindingId, command),
    );
  agent
    .command(GET)
    .description("Get a worker binding agent as JSON")
    .argument("<project-id>", "Project ID")
    .argument("<worker-binding-id>", "Worker binding ID")
    .argument("<agent-name>", "Agent name")
    .action(
      (
        projectId: string,
        workerBindingId: string,
        agentName: string,
        _options,
        command: Command,
      ) => agentGet(projectId, workerBindingId, agentName, command),
    );
}

function addBindingCommands(project: Command): void {
  const binding = project
    .command(BINDING)
    .description("Project binding commands");
  binding.action(() => binding.help());
  binding
    .command(LIST)
    .description("List project bindings as JSON")
    .argument("<project-id>", "Project ID")
    .option(
      "--kind <kind>",
      "Filter by binding kind",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--state <state>", "Filter by binding state", singleUse("--state"))
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((projectId: string, _options, command: Command) =>
      bindingList(projectId, command),
    );
  binding
    .command(GET)
    .description("Get a project binding as JSON")
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Binding ID")
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        bindingGet(projectId, bindingId, command),
    );
  binding
    .command(EXPORT)
    .description("Export the current binding set as JSON")
    .argument("<project-id>", "Project ID")
    .action((projectId: string, _options, command: Command) =>
      bindingExport(projectId, command),
    );
  binding
    .command(APPLY)
    .description("Apply a complete project binding set as JSON")
    .argument("<project-id>", "Project ID")
    .requiredOption(
      "--file <path>",
      "Binding set JSON file",
      singleUse("--file"),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((projectId: string, _options, command: Command) =>
      bindingApply(projectId, command),
    );
  const revision = binding
    .command(REVISION)
    .description("Project binding revisions");
  revision.action(() => revision.help());
  revision
    .command(LIST)
    .description("List project binding revisions as JSON")
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Binding ID")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        bindingRevisionList(projectId, bindingId, command),
    );
}
