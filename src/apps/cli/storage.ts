import type { Command } from "commander";
import { storageOperations } from "../../storage/contract.ts";
import { CommandName } from "./constants.ts";
import { addCredentialCommand } from "./credential.ts";

export function addStorageCommand(program: Command): void {
  addCredentialCommand(program, {
    name: CommandName.Storage,
    description: "Storage component commands",
    operations: storageOperations,
  });
}
