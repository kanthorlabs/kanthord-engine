import type { Command } from "commander";

export function planCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "plan",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("plan").description("manage plans");
}
