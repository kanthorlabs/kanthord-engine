import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { repositoryShowResponse } from "../../http/contract/repository.ts";
import { repositoryCommand } from "./index.ts";

export type ShowRepositoryInput = Readonly<{
  program: Command;
  client: DaemonClient;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerRepositoryShow(input: ShowRepositoryInput): void {
  repositoryCommand(input.program)
    .command("show")
    .description("show a registered repository")
    .option("--id <id>", "repository id")
    .action(async (options: { id?: string }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const result = await input.client.call("repository.show", undefined, {
        id: options.id,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const view = repositoryShowResponse.parse(result.body);
      input.stdout(`kanthord: registered ${view.name} ${view.id}\n`);
      input.stdout(`kanthord: upstream ${view.upstreamBranch}\n`);
      input.stdout(`kanthord: landing ${view.landingRef} ${view.landingOid}\n`);
      input.stdout(
        `kanthord: tracking ${view.trackingRef} ${view.trackingOid}\n`,
      );
      input.stdout(`kanthord: publish ${view.publishRef}\n`);
      input.stdout(`kanthord: state ${view.state}\n`);
      input.stdout(
        `kanthord: credential ${view.credential.name} ${view.credential.id}\n`,
      );
    });
}
