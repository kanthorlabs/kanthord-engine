import assert from "node:assert/strict";
import { Command } from "commander";
import {
  custodyOperations,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
} from "../../custody/contract.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import {
  handleReadResult,
  parsePositiveInt,
  requireToken,
  singleUse,
} from "./shared.ts";

const LIST = "list";
const GET = "get";
const LOGIN_STATUS = "login-status";
const LIST_TOKEN_REQUIRED = "cli.credential.list.token_required";
const GET_TOKEN_REQUIRED = "cli.credential.get.token_required";
const LOGIN_STATUS_TOKEN_REQUIRED =
  "cli.credential.login_status.token_required";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const LIST_INDETERMINATE = "cli.credential.list.indeterminate";
const GET_INDETERMINATE = "cli.credential.get.indeterminate";
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
    .command(LOGIN_STATUS)
    .description("Get a login session status as JSON")
    .argument("<session>", "Login session ID")
    .action((session: string, _options, command: Command) =>
      loginStatus(session, command),
    );
}
