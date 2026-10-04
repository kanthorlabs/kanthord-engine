import assert from "node:assert/strict";
import { Command } from "commander";
import {
  credentialCreateSchema,
  credentialRotateBodySchema,
  credentialUpdateMetadataBodySchema,
  custodyOperations,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
} from "../../custody/contract.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
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

const LIST = "list";
const GET = "get";
const PLATFORMS = "platforms";
const LOGIN_STATUS = "login-status";
const CREATE = "create";
const ROTATE = "rotate";
const UPDATE_METADATA = "update-metadata";
const REVOKE = "revoke";
const ARCHIVE = "archive";
const QUERY_TRUE = "true";
const QUERY_FALSE = "false";
const LOGIN = "login";
const LOGIN_CODE = "login-code";
const IDEMPOTENCY_KEY_OPTION = "--idempotency-key";
const FILE_OPTION = "--file";
const NAME_OPTION = "--name";
const MODE_OPTION = "--mode";
const CREATE_TOKEN_REQUIRED = "cli.credential.create.token_required";
const ROTATE_TOKEN_REQUIRED = "cli.credential.rotate.token_required";
const UPDATE_METADATA_TOKEN_REQUIRED =
  "cli.credential.update_metadata.token_required";
const ARCHIVE_TOKEN_REQUIRED = "cli.credential.archive.token_required";
const REVOKE_TOKEN_REQUIRED = "cli.credential.revoke.token_required";
const LOGIN_TOKEN_REQUIRED = "cli.credential.login.token_required";
const LOGIN_CODE_TOKEN_REQUIRED = "cli.credential.login_code.token_required";
const CREATE_INDETERMINATE = "cli.credential.create.indeterminate";
const ROTATE_INDETERMINATE = "cli.credential.rotate.indeterminate";
const UPDATE_METADATA_INDETERMINATE =
  "cli.credential.update_metadata.indeterminate";
const ARCHIVE_INDETERMINATE = "cli.credential.archive.indeterminate";
const REVOKE_INDETERMINATE = "cli.credential.revoke.indeterminate";
const LOGIN_INDETERMINATE = "cli.credential.login.indeterminate";
const LOGIN_CODE_INDETERMINATE = "cli.credential.login_code.indeterminate";
const REVOKE_INVALID_REVISION = "cli.credential.revoke.invalid_revision";
const LOGIN_INVALID_MODE = "cli.credential.login.invalid_mode";
const LOGIN_MODE_BROWSER = "browser";
const LOGIN_MODE_DEVICE = "device";
const LIST_TOKEN_REQUIRED = "cli.credential.list.token_required";
const GET_TOKEN_REQUIRED = "cli.credential.get.token_required";
const PLATFORMS_TOKEN_REQUIRED = "cli.credential.platforms.token_required";
const LOGIN_STATUS_TOKEN_REQUIRED =
  "cli.credential.login_status.token_required";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const LIST_INDETERMINATE = "cli.credential.list.indeterminate";
const GET_INDETERMINATE = "cli.credential.get.indeterminate";
const PLATFORMS_INDETERMINATE = "cli.credential.platforms.indeterminate";
const LOGIN_STATUS_INDETERMINATE = "cli.credential.login_status.indeterminate";

async function list(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, LIST_TOKEN_REQUIRED);
  const limit =
    options.limit === undefined
      ? LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${LIST_LIMIT_MAX}`,
    );
  const result = await httpClient(custodyOperations, endpoint, token).list({
    params: {},
    query: {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      includeArchived: options.includeArchived ? QUERY_TRUE : QUERY_FALSE,
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, LIST_INDETERMINATE))}\n`,
  );
}

async function get(credentialName: string, command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, GET_TOKEN_REQUIRED);
  const result = await httpClient(custodyOperations, endpoint, token).get({
    params: { credentialName },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, GET_INDETERMINATE))}\n`,
  );
}

async function platforms(command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, PLATFORMS_TOKEN_REQUIRED);
  const result = await httpClient(
    custodyOperations,
    endpoint,
    token,
  ).platform_list({
    params: {},
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, PLATFORMS_INDETERMINATE))}\n`,
  );
}

async function loginStatus(session: string, command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, LOGIN_STATUS_TOKEN_REQUIRED);
  const result = await httpClient(
    custodyOperations,
    endpoint,
    token,
  ).login_status({
    params: { sessionId: session },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, LOGIN_STATUS_INDETERMINATE))}\n`,
  );
}

async function create(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, CREATE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, credentialCreateSchema, true);
  const result = await httpClient(custodyOperations, endpoint, token).create(
    { params: {}, query: {}, body },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, CREATE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function rotate(credentialName: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, ROTATE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, credentialRotateBodySchema, true);
  const result = await httpClient(custodyOperations, endpoint, token).rotate(
    { params: { credentialName }, query: {}, body },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, ROTATE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function updateMetadata(
  credentialName: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, UPDATE_METADATA_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, credentialUpdateMetadataBodySchema);
  const result = await httpClient(
    custodyOperations,
    endpoint,
    token,
  ).update_metadata(
    { params: { credentialName }, query: {}, body },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, UPDATE_METADATA_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function revoke(
  credentialName: string,
  revision: string,
  command: Command,
): Promise<void> {
  const rev = parsePositiveInt(revision, REVOKE_INVALID_REVISION);
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, REVOKE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(custodyOperations, endpoint, token).revoke(
    { params: { credentialName, revision: rev }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, REVOKE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function archive(
  credentialName: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, ARCHIVE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(custodyOperations, endpoint, token).archive(
    { params: { credentialName }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, ARCHIVE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function login(platform: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const mode = options.mode;
  if (
    mode !== undefined &&
    mode !== LOGIN_MODE_BROWSER &&
    mode !== LOGIN_MODE_DEVICE
  )
    throw new Diagnostic(LOGIN_INVALID_MODE, "mode must be browser or device");
  const { endpoint, token } = resolveClient(options);
  requireToken(token, LOGIN_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(custodyOperations, endpoint, token).login(
    {
      params: {},
      query: {},
      body: { platform, name: options.name, ...(mode ? { mode } : {}) },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, LOGIN_INDETERMINATE, key);
  process.stdout.write(
    `${data.sessionId}\n${data.address}\n${data.code ?? ""}\n${data.expiresAt}\n${key}\n`,
  );
}

async function loginCode(
  session: string,
  value: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, LOGIN_CODE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(
    custodyOperations,
    endpoint,
    token,
  ).login_code(
    { params: { sessionId: session }, query: {}, body: { value } },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, LOGIN_CODE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

export function addCredentialCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some(
      (command) => command.name() === CommandName.Credential,
    ),
  );
  const credential = program
    .command(CommandName.Credential)
    .description("Credential commands")
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "Human JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  credential.action(() => credential.help());
  credential
    .command(LIST)
    .description("List credentials as JSON")
    .option(
      "--platform <platform>",
      "Filter by platform",
      singleUse("--platform"),
    )
    .option("--include-archived", "Include archived credentials", false)
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  credential
    .command(GET)
    .description("Get a credential as JSON")
    .argument("<credential-name>", "Credential name")
    .action((name: string, _options, command: Command) => get(name, command));
  credential
    .command(PLATFORMS)
    .description("List credential platforms as JSON")
    .action((_options, command: Command) => platforms(command));
  credential
    .command(LOGIN_STATUS)
    .description("Get a login session status as JSON")
    .argument("<session>", "Login session ID")
    .action((session: string, _options, command: Command) =>
      loginStatus(session, command),
    );
  credential
    .command(CREATE)
    .description("Create a credential as JSON")
    .requiredOption(
      "--file <path>",
      "Private credential JSON file",
      singleUse(FILE_OPTION),
    )
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((_options, command: Command) => create(command));
  credential
    .command(ROTATE)
    .description("Rotate a credential as JSON")
    .argument("<credential-name>", "Credential name")
    .requiredOption(
      "--file <path>",
      "Private credential JSON file",
      singleUse(FILE_OPTION),
    )
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((name: string, _options, command: Command) =>
      rotate(name, command),
    );
  credential
    .command(UPDATE_METADATA)
    .description("Update credential metadata as JSON")
    .argument("<credential-name>", "Credential name")
    .requiredOption(
      "--file <path>",
      "Metadata JSON file",
      singleUse(FILE_OPTION),
    )
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((name: string, _options, command: Command) =>
      updateMetadata(name, command),
    );
  credential
    .command(REVOKE)
    .description("Revoke a credential revision as JSON")
    .argument("<credential-name>", "Credential name")
    .argument("<revision>", "Revision number")
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((name: string, revision: string, _options, command: Command) =>
      revoke(name, revision, command),
    );
  credential
    .command(ARCHIVE)
    .description("Archive a credential as JSON")
    .argument("<credential-name>", "Credential name")
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((name: string, _options, command: Command) =>
      archive(name, command),
    );
  credential
    .command(LOGIN)
    .description("Start a credential login session")
    .argument("<platform>", "OAuth platform")
    .requiredOption("--name <name>", "Credential name", singleUse(NAME_OPTION))
    .option("--mode <mode>", "Browser or device", singleUse(MODE_OPTION))
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((platform: string, _options, command: Command) =>
      login(platform, command),
    );
  credential
    .command(LOGIN_CODE)
    .description("Supply a credential login code as JSON")
    .argument("<session>", "Login session ID")
    .argument("<value>", "Code or redirect URL")
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((session: string, value: string, _options, command: Command) =>
      loginCode(session, value, command),
    );
}
