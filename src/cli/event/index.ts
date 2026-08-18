import type { Command } from "commander";

export function eventCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "event",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("event").description("read the event log");
}
