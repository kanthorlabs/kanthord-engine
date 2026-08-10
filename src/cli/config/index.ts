import type { Command } from "commander";

export function configCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "config",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("config").description("configuration management");
}
