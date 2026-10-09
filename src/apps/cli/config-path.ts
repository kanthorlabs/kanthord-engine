import { Command } from "commander";
import { configPath } from "../../config/path.ts";

export function effectivePath(command: Command): string {
  return configPath(command.optsWithGlobals().config as string | undefined);
}

export function configHelp(command: Command): void {
  command.addHelpText(
    "after",
    () => `\nConfiguration file: ${effectivePath(command)}`,
  );
}
