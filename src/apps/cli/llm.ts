import assert from "node:assert/strict";
import { Command } from "commander";
import { llmOperations } from "../../llm/contract.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { CommandName } from "./constants.ts";
import {
  addCredentialCommand,
  credentialCode,
  IDEMPOTENCY_KEY_OPTION,
  type CredentialGroup,
} from "./credential.ts";
import {
  handleMutationResult,
  handleReadResult,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const LOGIN = "login";
const LOGIN_CODE = "login-code";
const LOGIN_STATUS = "login-status";
const LOGIN_CODE_CODE = "login_code";
const LOGIN_STATUS_CODE = "login_status";
const TOKEN_REQUIRED = "token_required";
const INDETERMINATE = "indeterminate";
const INVALID_MODE = "invalid_mode";
const NAME_OPTION = "--name";
const MODE_OPTION = "--mode";
const LOGIN_MODE_BROWSER = "browser";
const LOGIN_MODE_DEVICE = "device";
const PROVIDER = "provider";
const CHECK = "check";
const CREDENTIAL_OPTION = "--credential";

const LLM_GROUP: CredentialGroup = {
  name: CommandName.Llm,
  description: "LLM component commands",
  operations: llmOperations,
};

async function loginStatus(session: string, command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(
    token,
    credentialCode(LLM_GROUP, LOGIN_STATUS_CODE, TOKEN_REQUIRED),
  );
  const result = await httpClient(llmOperations, endpoint, token).login_status({
    params: { sessionId: session },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, credentialCode(LLM_GROUP, LOGIN_STATUS_CODE, INDETERMINATE)))}\n`,
  );
}

async function login(platform: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const mode = options.mode;
  if (
    mode !== undefined &&
    mode !== LOGIN_MODE_BROWSER &&
    mode !== LOGIN_MODE_DEVICE
  )
    throw new Diagnostic(
      credentialCode(LLM_GROUP, LOGIN, INVALID_MODE),
      "mode must be browser or device",
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, credentialCode(LLM_GROUP, LOGIN, TOKEN_REQUIRED));
  const key = resolveKey(options);
  const result = await httpClient(llmOperations, endpoint, token).login(
    {
      params: {},
      query: {},
      body: { platform, name: options.name, ...(mode ? { mode } : {}) },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    credentialCode(LLM_GROUP, LOGIN, INDETERMINATE),
    key,
  );
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
  requireToken(
    token,
    credentialCode(LLM_GROUP, LOGIN_CODE_CODE, TOKEN_REQUIRED),
  );
  const key = resolveKey(options);
  const result = await httpClient(llmOperations, endpoint, token).login_code(
    { params: { sessionId: session }, query: {}, body: { value } },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    credentialCode(LLM_GROUP, LOGIN_CODE_CODE, INDETERMINATE),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

function providerCheckCode(reason: string): string {
  return `cli.${CommandName.Llm}.${PROVIDER}.${CHECK}.${reason}`;
}

async function providerCheck(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, providerCheckCode(TOKEN_REQUIRED));
  const result = await httpClient(
    llmOperations,
    endpoint,
    token,
  ).provider_check({
    params: {},
    query: {},
    body: { credential: options.credential },
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, providerCheckCode(INDETERMINATE)))}\n`,
  );
}

export function addLlmCommand(program: Command): void {
  const credential = addCredentialCommand(program, LLM_GROUP);
  const component = credential.parent;
  assert.ok(component);
  const provider = component
    .command(PROVIDER)
    .description("LLM provider commands");
  provider.action(() => provider.help());
  provider
    .command(CHECK)
    .description("Check an LLM credential through its LLM provider as JSON")
    .requiredOption(
      "--credential <credential-name>",
      "Credential name",
      singleUse(CREDENTIAL_OPTION),
    )
    .action((_options, command: Command) => providerCheck(command));
  credential
    .command(LOGIN_STATUS)
    .description("Get a login session status as JSON")
    .argument("<session>", "Login session ID")
    .action((session: string, _options, command: Command) =>
      loginStatus(session, command),
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
