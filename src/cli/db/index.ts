import type { Command } from "commander";

export function dbCommand(program: Command): Command {
  const existing = program.commands.find((command) => command.name() === "db");
  if (existing !== undefined) {
    return existing;
  }
  return program.command("db").description("database maintenance");
}
