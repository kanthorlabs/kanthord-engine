import assert from "node:assert/strict";
import { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  environmentSchema,
  parseEnvironmentText,
} from "../../kernel/devcontainer.ts";
import { createIdempotencyKey, identitySchema } from "../../kernel/identity.ts";
import {
  BINDING_ID_PREFIX,
  BindingKind,
  BindingState,
  bindingSetWriteInputSchema,
  ENVIRONMENT_SECRET_PLATFORM,
  ENVIRONMENT_SECRET_VARIABLE,
  environmentSecretOperations,
  isNonblank,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  PROJECT_ID_PREFIX,
  PROJECT_NAME_MAX_LENGTH,
  projectNameSchema,
  projectOperations,
} from "../../project/contract.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { addFileBodyHelp } from "./file-body.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  readTextFile,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const REPOSITORY_CONFIG_EXAMPLE = {
  available: true,
  platform: "github",
  address: "git@github.com:owner/repository.git",
  strategy: {
    base_branch: "main",
    action: {
      name: "pull_request",
      follows: { type: "assessment_passed" },
    },
  },
  ssh_credential: "github-ssh",
  credential: "github-main",
};
const BINDING_APPLY_EXAMPLE = {
  version: 1,
  bindings: {
    "main-repo": { kind: "repository", config: REPOSITORY_CONFIG_EXAMPLE },
    "general-main": {
      kind: "worker",
      config: {
        worker: "coder@1",
        placement: "server",
        instance_count: 1,
        entries: [{ agent: "swe@1", reasoning_effort: "high" }],
      },
    },
  },
};
const BINDING_CHECK_EXAMPLE = {
  kind: "repository",
  config: REPOSITORY_CONFIG_EXAMPLE,
};

const CREATE = "create";
const LIST = "list";
const GET = "get";
const RENAME = "rename";
const PAUSE = "pause";
const RESUME = "resume";
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
const BINDING_VERIFY_INVALID_PROJECT_ID =
  "cli.project.binding.verify.invalid_project_id";
const BINDING_VERIFY_INVALID_BINDING_ID =
  "cli.project.binding.verify.invalid_binding_id";
const BINDING_VERIFY_TOKEN_REQUIRED =
  "cli.project.binding.verify.token_required";
const BINDING_VERIFY_INDETERMINATE = "cli.project.binding.verify.indeterminate";
const VERIFY = "verify";
const INSTRUCTION_FILES = "instruction-files";
const BINDING_INSTRUCTION_FILES_INVALID_PROJECT_ID =
  "cli.project.binding.instruction_files.invalid_project_id";
const BINDING_INSTRUCTION_FILES_INVALID_BINDING_ID =
  "cli.project.binding.instruction_files.invalid_binding_id";
const BINDING_INSTRUCTION_FILES_TOKEN_REQUIRED =
  "cli.project.binding.instruction_files.token_required";
const BINDING_INSTRUCTION_FILES_INDETERMINATE =
  "cli.project.binding.instruction_files.indeterminate";
const CHECK = "check";
const BINDING_CHECK_INVALID_PROJECT_ID =
  "cli.project.binding.check.invalid_project_id";
const BINDING_CHECK_TOKEN_REQUIRED = "cli.project.binding.check.token_required";
const BINDING_CHECK_INDETERMINATE = "cli.project.binding.check.indeterminate";

const ENVIRONMENT = "environment";
const SHOW = "show";
const SET = "set";
const REBUILD = "rebuild";
const UNSET = "unset";
const SECRET_SET = "secret.set";
const ENVIRONMENT_SECRET_VARIABLE_RULE =
  "use uppercase letters, digits and underscores, and start with a letter or an underscore";
const ENVIRONMENT_EXPORT_ABSENT =
  "cli.project.environment.export.environment_absent";
const EXPORT_INDENT = 2;
const ENVIRONMENT_SET_FILE_INVALID = "cli.project.environment.set.file_invalid";
const ENVIRONMENT_EXAMPLE = {
  image: "mcr.microsoft.com/devcontainers/python:3.12",
  features: { "ghcr.io/devcontainers/features/node:1": { version: "24" } },
  postCreateCommand: "pip install -r requirements.txt",
};

const PROJECT_NAME_RULE = `a lowercase letter, then lowercase letters, digits or hyphens, at most ${PROJECT_NAME_MAX_LENGTH} characters`;

function validateName(name: string, code: string): void {
  if (!projectNameSchema.safeParse(name).success)
    throw new Diagnostic(
      code,
      `invalid project name: use ${PROJECT_NAME_RULE}`,
    );
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
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
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
    params: { project_id: projectId },
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
    {
      params: { project_id: projectId },
      query: {},
      body: { name: options.name },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, RENAME_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function changePause(
  name: typeof PAUSE | typeof RESUME,
  projectId: string,
  command: Command,
): Promise<void> {
  const code = (suffix: string) => `cli.project.${name}.${suffix}`;
  validateProjectId(projectId, code("invalid_project_id"));
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code("token_required"));
  const key = resolveKey(options);
  const result = await httpClient(projectOperations, endpoint, token)[name](
    { params: { project_id: projectId }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, code("indeterminate"), key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
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
    params: { project_id: projectId },
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
    params: { project_id: projectId, binding_id: bindingId },
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
    params: { project_id: projectId },
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
  ](
    { params: { project_id: projectId }, query: {}, body },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, BINDING_APPLY_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
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
    params: { project_id: projectId, binding_id: bindingId },
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
    params: { project_id: projectId, binding_id: workerBindingId },
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
    params: {
      project_id: projectId,
      binding_id: workerBindingId,
      agent_name: agentName,
    },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, AGENT_GET_INDETERMINATE))}\n`,
  );
}

async function bindingVerify(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, BINDING_VERIFY_INVALID_PROJECT_ID);
  validateBindingId(bindingId, BINDING_VERIFY_INVALID_BINDING_ID);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, BINDING_VERIFY_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.verify"
  ]({
    params: { project_id: projectId, binding_id: bindingId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, BINDING_VERIFY_INDETERMINATE))}\n`,
  );
}

async function bindingInstructionFiles(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, BINDING_INSTRUCTION_FILES_INVALID_PROJECT_ID);
  validateBindingId(bindingId, BINDING_INSTRUCTION_FILES_INVALID_BINDING_ID);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, BINDING_INSTRUCTION_FILES_TOKEN_REQUIRED);
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.instruction_files.get"
  ]({
    params: { project_id: projectId, binding_id: bindingId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, BINDING_INSTRUCTION_FILES_INDETERMINATE))}\n`,
  );
}

async function bindingCheck(
  projectId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, BINDING_CHECK_INVALID_PROJECT_ID);
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, BINDING_CHECK_TOKEN_REQUIRED);
  const body = readJsonFileAs(
    options.file,
    projectOperations["binding.check"].input.shape.body,
  );
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.check"
  ]({ params: { project_id: projectId }, query: {}, body });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, BINDING_CHECK_INDETERMINATE))}
`,
  );
}

function environmentCode(leaf: string, suffix: string): string {
  return `cli.project.environment.${leaf}.${suffix}`;
}

async function readEnvironment(
  leaf: string,
  projectId: string,
  bindingId: string,
  command: Command,
) {
  validateProjectId(projectId, environmentCode(leaf, "invalid_project_id"));
  validateBindingId(bindingId, environmentCode(leaf, "invalid_binding_id"));
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, environmentCode(leaf, "token_required"));
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.environment.get"
  ]({
    params: { project_id: projectId, binding_id: bindingId },
    query: {},
    body: null,
  });
  return handleReadResult(result, environmentCode(leaf, "indeterminate"));
}

async function environmentShow(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  const answer = await readEnvironment(SHOW, projectId, bindingId, command);
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}

async function environmentExport(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  const answer = await readEnvironment(EXPORT, projectId, bindingId, command);
  if (answer.environment === null)
    throw new Diagnostic(
      ENVIRONMENT_EXPORT_ABSENT,
      answer.reason ?? "the binding holds no environment to export",
      { fields: [["source", answer.source]] },
    );
  process.stdout.write(
    `${JSON.stringify(answer.environment, null, EXPORT_INDENT)}\n`,
  );
}

async function environmentList(
  projectId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, environmentCode(LIST, "invalid_project_id"));
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, environmentCode(LIST, "token_required"));
  const result = await httpClient(projectOperations, endpoint, token)[
    "environment.list"
  ]({ params: { project_id: projectId }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, environmentCode(LIST, "indeterminate")))}\n`,
  );
}

function readEnvironmentFile(path: string) {
  const parsed = parseEnvironmentText(readTextFile(path));
  if (parsed.document === null)
    throw new Diagnostic(ENVIRONMENT_SET_FILE_INVALID, parsed.error, {
      fields: [["path", path]],
    });
  return parsed.document;
}

async function environmentSet(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, environmentCode(SET, "invalid_project_id"));
  validateBindingId(bindingId, environmentCode(SET, "invalid_binding_id"));
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, environmentCode(SET, "token_required"));
  const key = resolveKey(options);
  const environment = readEnvironmentFile(options.file);
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.environment.set"
  ](
    {
      params: { project_id: projectId, binding_id: bindingId },
      query: {},
      body: { environment },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    environmentCode(SET, "indeterminate"),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function environmentRebuild(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, environmentCode(REBUILD, "invalid_project_id"));
  validateBindingId(bindingId, environmentCode(REBUILD, "invalid_binding_id"));
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, environmentCode(REBUILD, "token_required"));
  const key = resolveKey(options);
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.environment.rebuild"
  ](
    {
      params: { project_id: projectId, binding_id: bindingId },
      query: {},
      body: null,
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    environmentCode(REBUILD, "indeterminate"),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function environmentUnset(
  projectId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateProjectId(projectId, environmentCode(UNSET, "invalid_project_id"));
  validateBindingId(bindingId, environmentCode(UNSET, "invalid_binding_id"));
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, environmentCode(UNSET, "token_required"));
  const key = resolveKey(options);
  const result = await httpClient(projectOperations, endpoint, token)[
    "binding.environment.set"
  ](
    {
      params: { project_id: projectId, binding_id: bindingId },
      query: {},
      body: { environment: null },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    environmentCode(UNSET, "indeterminate"),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

function readSecretFile(path: string): string {
  const code = environmentCode(SECRET_SET, "file_invalid");
  let text: string;
  try {
    text = readTextFile(path);
  } catch (error) {
    if (error instanceof Diagnostic)
      throw new Diagnostic(code, error.message, { fields: [["path", path]] });
    throw new Diagnostic(code, "the file cannot be read", {
      fields: [["path", path]],
    });
  }
  if (!isNonblank(text))
    throw new Diagnostic(code, "the file holds no secret", {
      fields: [["path", path]],
    });
  return text;
}

async function environmentSecretSet(
  projectId: string,
  bindingId: string,
  variable: string,
  command: Command,
): Promise<void> {
  validateProjectId(
    projectId,
    environmentCode(SECRET_SET, "invalid_project_id"),
  );
  validateBindingId(
    bindingId,
    environmentCode(SECRET_SET, "invalid_binding_id"),
  );
  if (!ENVIRONMENT_SECRET_VARIABLE.test(variable))
    throw new Diagnostic(
      environmentCode(SECRET_SET, "invalid_variable"),
      `invalid variable name: ${ENVIRONMENT_SECRET_VARIABLE_RULE}`,
    );
  const options = command.optsWithGlobals();
  const secret = readSecretFile(options.file);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, environmentCode(SECRET_SET, "token_required"));
  const key = resolveKey(options);
  const indeterminate = environmentCode(SECRET_SET, "indeterminate");
  const credentials = httpClient(environmentSecretOperations, endpoint, token);
  const credentialName: string = options.credential;
  const existing = await credentials.get({
    params: { credential_name: credentialName },
    query: {},
    body: null,
  });
  const credentialKey = createIdempotencyKey();
  if (existing.type === OperationResultType.Completed)
    handleMutationResult(
      await credentials.rotate(
        {
          params: { credential_name: credentialName },
          query: {},
          body: {
            expected_revision: Math.max(
              ...existing.data.revisions.map(({ revision }) => revision),
            ),
            secret: { key: secret },
          },
        },
        { idempotencyKey: credentialKey },
      ),
      indeterminate,
      credentialKey,
    );
  else if (
    existing.type === OperationResultType.Failure &&
    existing.status === HttpStatus.NotFound
  )
    handleMutationResult(
      await credentials.create(
        {
          params: {},
          query: {},
          body: {
            name: credentialName,
            platform: ENVIRONMENT_SECRET_PLATFORM,
            secret: { key: secret },
            metadata: null,
          },
        },
        { idempotencyKey: credentialKey },
      ),
      indeterminate,
      credentialKey,
    );
  else handleReadResult(existing, indeterminate);
  const projects = httpClient(projectOperations, endpoint, token);
  const binding = handleReadResult(
    await projects["binding.get"]({
      params: { project_id: projectId, binding_id: bindingId },
      query: {},
      body: null,
    }),
    indeterminate,
  );
  const current = handleReadResult(
    await projects["bindingSet.get"]({
      params: { project_id: projectId },
      query: {},
      body: null,
    }),
    indeterminate,
  );
  const target = current.bindings[binding.name];
  if (target?.kind !== BindingKind.Repository)
    throw new Diagnostic(
      environmentCode(SECRET_SET, "binding_not_found"),
      "the binding is not a current repository binding",
    );
  const written = await projects["bindingSet.write"](
    {
      params: { project_id: projectId },
      query: {},
      body: {
        version: current.version,
        bindings: {
          ...current.bindings,
          [binding.name]: {
            kind: target.kind,
            config: {
              ...target.config,
              environment_secrets: {
                ...target.config.environment_secrets,
                [variable]: credentialName,
              },
            },
          },
        },
      },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(written, indeterminate, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

function addEnvironmentCommands(project: Command): void {
  const environment = project
    .command(ENVIRONMENT)
    .description("Project environment commands");
  environment.action(() => environment.help());
  environment
    .command(LIST)
    .description("List the environment state of each repository binding")
    .argument("<project-id>", "Project ID")
    .action((projectId: string, _options, command: Command) =>
      environmentList(projectId, command),
    );
  environment
    .command(REBUILD)
    .description(
      "Discard the proof and the images of the environment of a repository binding and build it again",
    )
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Repository binding ID")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        environmentRebuild(projectId, bindingId, command),
    );
  environment
    .command(EXPORT)
    .description(
      "Print the environment of a repository binding as indented JSON for a devcontainer.json file",
    )
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Repository binding ID")
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        environmentExport(projectId, bindingId, command),
    );
  environment
    .command(UNSET)
    .description(
      "Remove the stored environment of a repository binding as a new binding revision",
    )
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Repository binding ID")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        environmentUnset(projectId, bindingId, command),
    );
  environment
    .command(SHOW)
    .description(
      "Show the environment of a repository binding as JSON with its source: stored, repository, detected, universal or none",
    )
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Repository binding ID")
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        environmentShow(projectId, bindingId, command),
    );
  const secret = environment
    .command("secret")
    .description("Environment secret commands");
  secret.action(() => secret.help());
  addFileBodyHelp(
    secret
      .command(SET)
      .description(
        "Store a secret as an environment_secret credential and name it in the environment secrets of a repository binding",
      )
      .argument("<project-id>", "Project ID")
      .argument("<binding-id>", "Repository binding ID")
      .argument("<variable>", "Environment variable name")
      .requiredOption(
        "--credential <name>",
        "Credential name",
        singleUse("--credential"),
      )
      .requiredOption(
        "--file <path>",
        "File that holds the secret text",
        singleUse("--file"),
      )
      .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION)),
    {
      example: "<secret text>",
      note: "The file text is the secret, byte for byte. The command never prints it.",
    },
  ).action(
    (
      projectId: string,
      bindingId: string,
      variable: string,
      _options,
      command: Command,
    ) => environmentSecretSet(projectId, bindingId, variable, command),
  );
  addFileBodyHelp(
    environment
      .command(SET)
      .description(
        "Store the environment of a repository binding as a new binding revision as JSON",
      )
      .argument("<project-id>", "Project ID")
      .argument("<binding-id>", "Repository binding ID")
      .requiredOption(
        "--file <path>",
        "devcontainer.json file; comments and trailing commas are accepted",
        singleUse("--file"),
      )
      .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION)),
    {
      schema: environmentSchema,
      example: ENVIRONMENT_EXAMPLE,
      note: "The file is a devcontainer.json document. KanthorD never writes it to the repository.",
    },
  ).action((projectId: string, bindingId: string, _options, command: Command) =>
    environmentSet(projectId, bindingId, command),
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
    .requiredOption(
      "--name <name>",
      `Project name: ${PROJECT_NAME_RULE}`,
      singleUse(NAME_OPTION),
    )
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
    .requiredOption(
      "--name <name>",
      `Project name: ${PROJECT_NAME_RULE}`,
      singleUse(NAME_OPTION),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((projectId: string, _options, command: Command) =>
      rename(projectId, command),
    );
  project
    .command(PAUSE)
    .description("Pause a project as JSON")
    .argument("<project-id>", "Project ID")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((projectId: string, _options, command: Command) =>
      changePause(PAUSE, projectId, command),
    );
  project
    .command(RESUME)
    .description("Resume a project as JSON")
    .argument("<project-id>", "Project ID")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((projectId: string, _options, command: Command) =>
      changePause(RESUME, projectId, command),
    );
  addBindingCommands(project);
  addAgentCommands(project);
  addEnvironmentCommands(project);
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
  addFileBodyHelp(
    binding
      .command(APPLY)
      .description("Apply a complete project binding set as JSON")
      .argument("<project-id>", "Project ID")
      .requiredOption(
        "--file <path>",
        "Binding set JSON file",
        singleUse("--file"),
      )
      .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION)),
    {
      schema: bindingSetWriteInputSchema,
      example: BINDING_APPLY_EXAMPLE,
      note: "Copy version from binding export. The file replaces the whole binding set.",
    },
  ).action((projectId: string, _options, command: Command) =>
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
  binding
    .command(VERIFY)
    .description("Verify a repository binding address and credential as JSON")
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Binding ID")
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        bindingVerify(projectId, bindingId, command),
    );
  binding
    .command(INSTRUCTION_FILES)
    .description("Read the instruction files of a repository binding as JSON")
    .argument("<project-id>", "Project ID")
    .argument("<binding-id>", "Binding ID")
    .action(
      (projectId: string, bindingId: string, _options, command: Command) =>
        bindingInstructionFiles(projectId, bindingId, command),
    );
  addFileBodyHelp(
    binding
      .command(CHECK)
      .description("Check an unsaved repository binding as JSON")
      .argument("<project-id>", "Project ID")
      .requiredOption(
        "--file <path>",
        "Repository binding JSON file",
        singleUse("--file"),
      ),
    {
      schema: projectOperations["binding.check"].input.shape.body,
      example: BINDING_CHECK_EXAMPLE,
    },
  ).action((projectId: string, _options, command: Command) =>
    bindingCheck(projectId, command),
  );
}
