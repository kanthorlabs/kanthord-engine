import assert from "node:assert/strict";
import { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
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
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const CREATE = "create";
const LIST = "list";
const GET = "get";
const RENAME = "rename";
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

function validateName(name: string, code: string): void {
  if (!projectNameSchema.safeParse(name).success)
    throw new Diagnostic(code, "invalid project name");
}

export function validateProjectId(id: string, code: string): void {
  if (!identitySchema(PROJECT_ID_PREFIX).safeParse(id).success)
    throw new Diagnostic(code, "invalid project ID");
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
  const limit =
    options.limit === undefined
      ? LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${LIST_LIMIT_MAX}`,
    );
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
}
