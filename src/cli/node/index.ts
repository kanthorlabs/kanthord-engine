import type { Command } from "commander";

export function nodeCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "node",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("node").description("manage graph nodes");
}
