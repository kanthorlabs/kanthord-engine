import type { Command } from "commander";
import type { z } from "zod";
import { isString } from "../../kernel/values.ts";

export type FileBody = {
  schema?: z.ZodTypeAny;
  example: unknown;
  note?: string;
};

export const EXAMPLE_MARKER = "Example:";
const JSON_INDENT = 2;
const LINE_INDENT = "  ";
const bodies = new WeakMap<Command, FileBody>();

function exampleText(example: unknown): string {
  return isString(example)
    ? example
    : JSON.stringify(example, null, JSON_INDENT);
}

function helpText(body: FileBody): string {
  const kind = body.schema === undefined ? "UTF-8 text" : "JSON";
  const note = body.note === undefined ? "" : ` ${body.note}`;
  const lines = exampleText(body.example)
    .split("\n")
    .map((line) => `${LINE_INDENT}${line}`);
  return `\nFile body: ${kind}.${note}\n${EXAMPLE_MARKER}\n${lines.join("\n")}\n`;
}

export function fileBodyOf(command: Command): FileBody | undefined {
  return bodies.get(command);
}

export function addFileBodyHelp(command: Command, body: FileBody): Command {
  bodies.set(command, body);
  return command.addHelpText("after", helpText(body));
}
