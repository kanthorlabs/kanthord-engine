import type { Command } from "commander";

export function projectCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "project",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("project").description("manage projects");
}
