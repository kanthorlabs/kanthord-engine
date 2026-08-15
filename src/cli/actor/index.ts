import type { Command } from "commander";

export function actorCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "actor",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("actor").description("manage actors");
}
