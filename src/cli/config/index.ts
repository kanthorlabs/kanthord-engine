import type { Command } from "commander";

const searchOrderHelp = [
  "Configuration search order at daemon start:",
  "  1. the --config <path> file, and no other candidate",
  "  2. $KANTHORD_CONFIG",
  "  3. ./kanthord.config.json",
  "  4. $XDG_CONFIG_HOME/kanthord/config.json (default ~/.config/kanthord/config.json)",
  "  5. /etc/kanthord/config.json",
  "",
  "The daemon loads the first candidate that exists.",
].join("\n");

export function configCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "config",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program
    .command("config")
    .description("configuration management")
    .addHelpText("after", `\n${searchOrderHelp}`);
}
