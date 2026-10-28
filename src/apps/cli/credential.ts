import assert from "node:assert/strict";
import type { Command } from "commander";
import {
  credentialCheckBodySchema,
  credentialCreateSchema,
  credentialRotateBodySchema,
  credentialUpdateMetadataBodySchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
} from "../../custody/contract.ts";
import type { z } from "zod";
import type { llmOperations } from "../../llm/contract.ts";
import type { repositoryOperations } from "../../repository/contract.ts";
import type { storageOperations } from "../../storage/contract.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { instanceCredentialAccess, instanceSecret } from "../worker/index.ts";
import { readNamedInstance } from "../worker/instance-config.ts";
import { PROGRAM_NAME } from "./constants.ts";
import { addFileBodyHelp } from "./file-body.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const CREDENTIAL_GROUP = "credential";
export const IDEMPOTENCY_KEY_OPTION = "--idempotency-key";
const LIST = "list";
const GET = "get";
const PLATFORMS = "platforms";
const CREATE = "create";
const ROTATE = "rotate";
const UPDATE_METADATA = "update-metadata";
const REVOKE = "revoke";
const ARCHIVE = "archive";
const CHECK = "check";
const VERIFY = "verify";
const QUERY_TRUE = "true";
const QUERY_FALSE = "false";
const FILE_OPTION = "--file";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";

type CredentialOperations =
  typeof llmOperations | typeof repositoryOperations | typeof storageOperations;
export type CredentialGroup = {
  name: string;
  description: string;
  operations: CredentialOperations;
  example: { platform: string; metadata: unknown; secret: unknown };
  instanceCopies?: boolean;
};

export function credentialCode(
  group: CredentialGroup,
  command: string,
  reason: string,
): string {
  return `cli.${group.name}.${CREDENTIAL_GROUP}.${command}.${reason}`;
}

const TOKEN_REQUIRED = "token_required";
const INDETERMINATE = "indeterminate";
const INVALID_REVISION = "invalid_revision";
const UPDATE_METADATA_CODE = "update_metadata";
const HOLDER_OPTION = "--holder";

function holderQuery(
  group: CredentialGroup,
  options: { holder?: string },
): Record<string, never> {
  if (options.holder === undefined) return {};
  assert.ok(group.instanceCopies);
  return { holder: options.holder } as unknown as Record<string, never>;
}

function writeAnswer(data: unknown, key: string): void {
  process.stdout.write(
    `${JSON.stringify({ ...(data as object), idempotency_key: key })}\n`,
  );
}

async function createLocal(
  group: CredentialGroup,
  holder: string,
  body: z.infer<typeof credentialCreateSchema>,
  key: string,
): Promise<boolean> {
  const configuration = readNamedInstance(process.env, holder);
  if (configuration === null) return false;
  instanceSecret(body.secret);
  const access = await instanceCredentialAccess(configuration);
  const sealed = await access.seal(body.name, body.platform, body.secret);
  const result = await httpClient(
    llmOperationsOf(group),
    access.endpoint,
    access.token,
  ).create(
    {
      params: {},
      query: {},
      body: {
        name: body.name,
        platform: body.platform,
        metadata: body.metadata,
        ...sealed,
      },
    },
    { idempotencyKey: key },
  );
  writeAnswer(
    handleMutationResult(
      result,
      credentialCode(group, CREATE, INDETERMINATE),
      key,
    ),
    key,
  );
  return true;
}

async function rotateLocal(
  group: CredentialGroup,
  credentialName: string,
  holder: string,
  body: z.infer<typeof credentialRotateBodySchema>,
  key: string,
): Promise<boolean> {
  const configuration = readNamedInstance(process.env, holder);
  if (configuration === null) return false;
  instanceSecret(body.secret);
  const access = await instanceCredentialAccess(configuration);
  const client = httpClient(
    llmOperationsOf(group),
    access.endpoint,
    access.token,
  );
  const current = handleReadResult(
    await client.get({
      params: { credential_name: credentialName },
      query: { holder },
      body: null,
    }),
    credentialCode(group, ROTATE, INDETERMINATE),
  );
  const sealed = await access.seal(
    credentialName,
    current.platform,
    body.secret,
  );
  const result = await client.rotate(
    {
      params: { credential_name: credentialName },
      query: {},
      body: {
        expected_revision: body.expected_revision,
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
        ...sealed,
      },
    },
    { idempotencyKey: key },
  );
  writeAnswer(
    handleMutationResult(
      result,
      credentialCode(group, ROTATE, INDETERMINATE),
      key,
    ),
    key,
  );
  return true;
}

function llmOperationsOf(group: CredentialGroup): typeof llmOperations {
  assert.ok(group.instanceCopies);
  return group.operations as typeof llmOperations;
}

async function list(group: CredentialGroup, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(group, LIST, TOKEN_REQUIRED));
  const limit =
    options.limit === undefined
      ? LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${LIST_LIMIT_MAX}`,
    );
  const result = await httpClient(group.operations, endpoint, token).list({
    params: {},
    query: {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      include_archived: options.includeArchived ? QUERY_TRUE : QUERY_FALSE,
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...holderQuery(group, options),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, credentialCode(group, LIST, INDETERMINATE)))}\n`,
  );
}

async function get(
  group: CredentialGroup,
  credentialName: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(group, GET, TOKEN_REQUIRED));
  const result = await httpClient(group.operations, endpoint, token).get({
    params: { credential_name: credentialName },
    query: holderQuery(group, options),
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult<unknown>(result, credentialCode(group, GET, INDETERMINATE)))}\n`,
  );
}

async function verify(
  group: CredentialGroup,
  credentialName: string,
  command: Command,
): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, credentialCode(group, VERIFY, TOKEN_REQUIRED));
  const result = await httpClient(group.operations, endpoint, token).verify({
    params: { credential_name: credentialName },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult<unknown>(result, credentialCode(group, VERIFY, INDETERMINATE)))}\n`,
  );
}

async function platforms(
  group: CredentialGroup,
  command: Command,
): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, credentialCode(group, PLATFORMS, TOKEN_REQUIRED));
  const result = await httpClient(
    group.operations,
    endpoint,
    token,
  ).platform_list({
    params: {},
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, credentialCode(group, PLATFORMS, INDETERMINATE)))}\n`,
  );
}

async function create(group: CredentialGroup, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, credentialCreateSchema, true);
  const holder: string | undefined = options.holder;
  if (holder !== undefined && (await createLocal(group, holder, body, key)))
    return;
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(group, CREATE, TOKEN_REQUIRED));
  const result = await httpClient(group.operations, endpoint, token).create(
    {
      params: {},
      query: {},
      body: holder === undefined ? body : { ...body, holders: [holder] },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    credentialCode(group, CREATE, INDETERMINATE),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function rotate(
  group: CredentialGroup,
  credentialName: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, credentialRotateBodySchema, true);
  const holder: string | undefined = options.holder;
  if (
    holder !== undefined &&
    (await rotateLocal(group, credentialName, holder, body, key))
  )
    return;
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(group, ROTATE, TOKEN_REQUIRED));
  const result = await httpClient(group.operations, endpoint, token).rotate(
    {
      params: { credential_name: credentialName },
      query: holderQuery(group, options),
      body,
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    credentialCode(group, ROTATE, INDETERMINATE),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function updateMetadata(
  group: CredentialGroup,
  credentialName: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(
    token,
    credentialCode(group, UPDATE_METADATA_CODE, TOKEN_REQUIRED),
  );
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, credentialUpdateMetadataBodySchema);
  const result = await httpClient(
    group.operations,
    endpoint,
    token,
  ).update_metadata(
    {
      params: { credential_name: credentialName },
      query: holderQuery(group, options),
      body,
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    credentialCode(group, UPDATE_METADATA_CODE, INDETERMINATE),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function revoke(
  group: CredentialGroup,
  credentialName: string,
  revision: string,
  command: Command,
): Promise<void> {
  const rev = parsePositiveInt(
    revision,
    credentialCode(group, REVOKE, INVALID_REVISION),
  );
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(group, REVOKE, TOKEN_REQUIRED));
  const key = resolveKey(options);
  const result = await httpClient(group.operations, endpoint, token).revoke(
    {
      params: { credential_name: credentialName, revision: rev },
      query: holderQuery(group, options),
      body: null,
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    credentialCode(group, REVOKE, INDETERMINATE),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function archive(
  group: CredentialGroup,
  credentialName: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(group, ARCHIVE, TOKEN_REQUIRED));
  const key = resolveKey(options);
  const result = await httpClient(group.operations, endpoint, token).archive(
    {
      params: { credential_name: credentialName },
      query: holderQuery(group, options),
      body: null,
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    credentialCode(group, ARCHIVE, INDETERMINATE),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function check(group: CredentialGroup, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(group, CHECK, TOKEN_REQUIRED));
  const body = readJsonFileAs(options.file, credentialCheckBodySchema, true);
  const result = await httpClient(group.operations, endpoint, token).check({
    params: {},
    query: {},
    body,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, credentialCode(group, CHECK, INDETERMINATE)))}\n`,
  );
}

function withHolder(
  group: CredentialGroup,
  command: Command,
  description: string,
): Command {
  if (!group.instanceCopies) return command;
  return command.option(
    "--holder <name>",
    description,
    singleUse(HOLDER_OPTION),
  );
}

const HOLDER_READ =
  "Holder of the credential copy: server or an instance name (default server)";
const HOLDER_WRITE =
  "Instance that holds the copy; with its instance file the CLI seals the secret locally";

export function addCredentialCommand(
  program: Command,
  group: CredentialGroup,
): Command {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(!program.commands.some((command) => command.name() === group.name));
  const component = program
    .command(group.name)
    .description(group.description)
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "Human JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  component.action(() => component.help());
  const credential = component
    .command(CREDENTIAL_GROUP)
    .description("Credential commands");
  credential.action(() => credential.help());
  withHolder(
    group,
    credential.command(LIST).description("List credentials as JSON"),
    "Filter by holder: server or an instance name",
  )
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
    .action((_options, command: Command) => list(group, command));
  withHolder(
    group,
    credential.command(GET).description("Get a credential as JSON"),
    HOLDER_READ,
  )
    .argument("<credential-name>", "Credential name")
    .action((name: string, _options, command: Command) =>
      get(group, name, command),
    );
  credential
    .command(VERIFY)
    .description("Verify a stored credential as JSON")
    .argument("<credential-name>", "Credential name")
    .action((name: string, _options, command: Command) =>
      verify(group, name, command),
    );
  credential
    .command(PLATFORMS)
    .description("List credential platforms as JSON")
    .action((_options, command: Command) => platforms(group, command));
  addFileBodyHelp(
    withHolder(
      group,
      credential.command(CREATE).description("Create a credential as JSON"),
      HOLDER_WRITE,
    )
      .requiredOption(
        "--file <path>",
        "Private credential JSON file",
        singleUse(FILE_OPTION),
      )
      .option(
        "--idempotency-key <key>",
        "Mutation key",
        singleUse(IDEMPOTENCY_KEY_OPTION),
      ),
    {
      schema: credentialCreateSchema,
      example: { name: "main", ...group.example },
      note: "The file must have mode 0600.",
    },
  ).action((_options, command: Command) => create(group, command));
  addFileBodyHelp(
    withHolder(
      group,
      credential.command(ROTATE).description("Rotate a credential as JSON"),
      HOLDER_WRITE,
    )
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
      ),
    {
      schema: credentialRotateBodySchema,
      example: { expected_revision: 1, secret: group.example.secret },
      note: "The file must have mode 0600. Add metadata to change it too.",
    },
  ).action((name: string, _options, command: Command) =>
    rotate(group, name, command),
  );
  addFileBodyHelp(
    withHolder(
      group,
      credential
        .command(UPDATE_METADATA)
        .description("Update credential metadata as JSON"),
      HOLDER_READ,
    )
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
      ),
    {
      schema: credentialUpdateMetadataBodySchema,
      example: { expected_revision: 1, metadata: group.example.metadata },
    },
  ).action((name: string, _options, command: Command) =>
    updateMetadata(group, name, command),
  );
  withHolder(
    group,
    credential
      .command(REVOKE)
      .description("Revoke a credential revision as JSON"),
    HOLDER_READ,
  )
    .argument("<credential-name>", "Credential name")
    .argument("<revision>", "Revision number")
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((name: string, revision: string, _options, command: Command) =>
      revoke(group, name, revision, command),
    );
  withHolder(
    group,
    credential.command(ARCHIVE).description("Archive a credential as JSON"),
    HOLDER_READ,
  )
    .argument("<credential-name>", "Credential name")
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((name: string, _options, command: Command) =>
      archive(group, name, command),
    );
  addFileBodyHelp(
    credential
      .command(CHECK)
      .description("Check a typed credential secret before the save as JSON")
      .requiredOption(
        "--file <path>",
        "Private credential JSON file",
        singleUse(FILE_OPTION),
      ),
    {
      schema: credentialCheckBodySchema,
      example: group.example,
      note: "The file must have mode 0600. The body has no name.",
    },
  ).action((_options, command: Command) => check(group, command));
  return credential;
}
