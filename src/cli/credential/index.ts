import type { Command } from "commander";

export function credentialCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "credential",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("credential").description("manage stored credentials");
}
