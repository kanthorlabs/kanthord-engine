import type { Command } from "commander";
import { storageOperations } from "../../storage/contract.ts";
import { CommandName } from "./constants.ts";
import { addCredentialCommand } from "./credential.ts";

export function addStorageCommand(program: Command): void {
  addCredentialCommand(program, {
    name: CommandName.Storage,
    description: "Storage component commands",
    operations: storageOperations,
    example: {
      platform: "s3",
      metadata: {
        endpoint: "https://s3.example.com",
        bucket: "kanthord",
        region: "us-east-1",
      },
      secret: {
        access_key_id: "<access-key-id>",
        secret_access_key: "<secret>",
      },
    },
  });
}
