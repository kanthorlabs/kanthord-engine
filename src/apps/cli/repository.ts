import type { Command } from "commander";
import { repositoryOperations } from "../../repository/contract.ts";
import { CommandName } from "./constants.ts";
import { addCredentialCommand } from "./credential.ts";

export function addRepositoryCommand(program: Command): void {
  addCredentialCommand(program, {
    name: CommandName.Repository,
    description: "Repository component commands",
    operations: repositoryOperations,
  });
}
