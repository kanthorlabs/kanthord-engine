import type { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  HOST_KEY_FINGERPRINT_PATTERN,
  repositoryOperations,
} from "../../repository/contract.ts";
import { CommandName } from "./constants.ts";
import { addCredentialCommand, IDEMPOTENCY_KEY_OPTION } from "./credential.ts";
import {
  handleMutationResult,
  handleReadResult,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const SSH_DISCOVER = "ssh-discover";
const SSH_DISCOVER_CODE = "cli.repository.credential.ssh_discover";
const HOST_KEY_GROUP = "host-key";
const HOST_KEY_CODE = "cli.repository.host_key";
const LIST = "list";
const SCAN = "scan";
const PIN = "pin";
const TOKEN_REQUIRED = "token_required";
const INDETERMINATE = "indeterminate";
const FINGERPRINT_INVALID = "fingerprint_invalid";

function hostKeyCode(command: string, reason: string): string {
  return `${HOST_KEY_CODE}.${command}.${reason}`;
}

async function sshDiscover(command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, `${SSH_DISCOVER_CODE}.token_required`);
  const result = await httpClient(
    repositoryOperations,
    endpoint,
    token,
  ).ssh_discover({ params: {}, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, `${SSH_DISCOVER_CODE}.indeterminate`))}\n`,
  );
}

async function hostKeyList(command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, hostKeyCode(LIST, TOKEN_REQUIRED));
  const result = await httpClient(
    repositoryOperations,
    endpoint,
    token,
  ).host_key_list({ params: {}, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, hostKeyCode(LIST, INDETERMINATE)))}\n`,
  );
}

async function hostKeyScan(host: string, command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, hostKeyCode(SCAN, TOKEN_REQUIRED));
  const result = await httpClient(
    repositoryOperations,
    endpoint,
    token,
  ).host_key_scan({ params: {}, query: {}, body: { host } });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, hostKeyCode(SCAN, INDETERMINATE)))}\n`,
  );
}

async function hostKeyPin(host: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  if (!HOST_KEY_FINGERPRINT_PATTERN.test(options.fingerprint))
    throw new Diagnostic(
      hostKeyCode(PIN, FINGERPRINT_INVALID),
      "fingerprint must be SHA256: and 43 base64 characters",
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, hostKeyCode(PIN, TOKEN_REQUIRED));
  const key = resolveKey(options);
  const result = await httpClient(
    repositoryOperations,
    endpoint,
    token,
  ).host_key_pin(
    {
      params: { host },
      query: {},
      body: { fingerprint: options.fingerprint },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    hostKeyCode(PIN, INDETERMINATE),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

export function addRepositoryCommand(program: Command): void {
  const credential = addCredentialCommand(program, {
    name: CommandName.Repository,
    description: "Repository component commands",
    operations: repositoryOperations,
    example: {
      platform: "ssh",
      metadata: {
        host: "github.com",
        hostname: "github.com",
        port: 22,
        identity_file: "/home/user/.ssh/id_ed25519",
      },
      secret: {},
    },
  });
  credential
    .command(SSH_DISCOVER)
    .description("List the SSH aliases of ~/.ssh/config as JSON")
    .action((_options, command: Command) => sshDiscover(command));
  const hostKey = credential
    .parent!.command(HOST_KEY_GROUP)
    .description("SSH host key commands");
  hostKey.action(() => hostKey.help());
  hostKey
    .command(LIST)
    .description("List the pinned SSH host keys as JSON")
    .action((_options, command: Command) => hostKeyList(command));
  hostKey
    .command(SCAN)
    .description("Read the host key of an SSH host as JSON")
    .argument("<host>", "SSH host")
    .action((host: string, _options, command: Command) =>
      hostKeyScan(host, command),
    );
  hostKey
    .command(PIN)
    .description("Pin the confirmed host key of an SSH host as JSON")
    .argument("<host>", "SSH host")
    .requiredOption(
      "--fingerprint <fingerprint>",
      "Confirmed SHA256 fingerprint",
      singleUse("--fingerprint"),
    )
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse(IDEMPOTENCY_KEY_OPTION),
    )
    .action((host: string, _options, command: Command) =>
      hostKeyPin(host, command),
    );
}
