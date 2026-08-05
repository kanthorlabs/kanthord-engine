import type { Command } from "commander";

export function repositoryCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "repository",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program
    .command("repository")
    .description("manage registered repositories");
}
