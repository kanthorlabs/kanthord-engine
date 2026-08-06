import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { projectRepositoriesResponse } from "../../http/contract/project.ts";
import { repositoryListResponse } from "../../http/contract/repository.ts";
import { projectCommand } from "./index.ts";
import { printProjectView } from "./view.ts";

export type ProjectRepositoryCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

const collectRepositoryNames = (
  value: string,
  previous: string[],
): string[] => [...previous, value];

export function registerProjectRepository(
  input: ProjectRepositoryCliInput,
): void {
  const group = projectCommand(input.program);
  if (group.commands.some((command) => command.name() === "repository")) {
    return;
  }
  group
    .command("repository")
    .description("bind repositories to a project")
    .option("--id <id>", "project id")
    .option(
      "--repository <name>",
      "repository name",
      collectRepositoryNames,
      [],
    )
    .action(async (options: { id?: string; repository?: string[] }) => {
      if (options.id === undefined) {
        input.stderr("kanthord: invalid-request: --id is required\n");
        input.fail();
        return;
      }
      const repositoryNames = options.repository ?? [];
      const repositories: string[] = [];
      if (repositoryNames.length > 0) {
        const listResult = await input.client.call(
          "repository.list",
          undefined,
        );
        if (!listResult.ok) {
          input.stderr(`kanthord: ${listResult.code}: ${listResult.message}\n`);
          input.fail();
          return;
        }
        const body = repositoryListResponse.parse(listResult.body);
        for (const name of repositoryNames) {
          const matched = body.repositories.find((item) => item.name === name);
          if (matched === undefined) {
            input.stderr(`kanthord: not-found: no repository named ${name}\n`);
            input.fail();
            return;
          }
          repositories.push(matched.id);
        }
      }
      const result = await input.client.call(
        "project.repositories",
        { repositories },
        { id: options.id },
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const view = projectRepositoriesResponse.parse(result.body);
      printProjectView(input.stdout, view);
    });
}
