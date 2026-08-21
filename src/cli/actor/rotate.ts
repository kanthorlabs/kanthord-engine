import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import type { SecretFileSink } from "../secret-file.ts";
import { actorRotateResponse } from "../../http/contract/actor.ts";
import { actorCommand } from "./index.ts";

export type RotateActorInput = Readonly<{
  program: Command;
  client: DaemonClient;
  createSecretFile: (path: string) => SecretFileSink;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerActorRotate(input: RotateActorInput): void {
  actorCommand(input.program)
    .command("rotate")
    .description("replace a harness token and disclose the new one once")
    .option("--id <id>", "actor id")
    .option("--output-token-file <path>", "path to write the disclosed token")
    .action(async (options: { id?: string; outputTokenFile?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      if (options.outputTokenFile === undefined) {
        input.stderr(
          "kanthord: invalid-request: --output-token-file is required\n",
        );
        input.fail();
        return;
      }
      const sink = input.createSecretFile(options.outputTokenFile);
      try {
        sink.write("");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.stderr(`kanthord: ${message}\n`);
        input.fail();
        return;
      }
      try {
        const result = await input.client.call("actor.rotate", undefined, {
          id: options.id,
        });
        if (!result.ok) {
          sink.discard();
          input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
          input.fail();
          return;
        }
        const view = actorRotateResponse.parse(result.body);
        sink.write(view.token);
        input.stdout(`${view.id}\n`);
        input.stdout(`token: [redacted] -> ${options.outputTokenFile}\n`);
      } catch (error) {
        sink.discard();
        const message = error instanceof Error ? error.message : String(error);
        input.stderr(`kanthord: ${message}\n`);
        input.fail();
      }
    });
}
