import type { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import { CommandName } from "./constants.ts";
import { addCredentialCommand } from "./credential.ts";
import { handleReadResult, requireToken } from "./shared.ts";

const SSH_DISCOVER = "ssh-discover";
const SSH_DISCOVER_CODE = "cli.repository.credential.ssh_discover";

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

export function addRepositoryCommand(program: Command): void {
  const credential = addCredentialCommand(program, {
    name: CommandName.Repository,
    description: "Repository component commands",
    operations: repositoryOperations,
  });
  credential
    .command(SSH_DISCOVER)
    .description("List the SSH aliases of ~/.ssh/config as JSON")
    .action((_options, command: Command) => sshDiscover(command));
}
