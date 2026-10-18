import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Command } from "commander";
import { temporary } from "../../kernel/test-support.ts";
import { ExitCode } from "./constants.ts";
import { EXAMPLE_MARKER, fileBodyOf } from "./file-body.ts";
import { createProgram } from "./index.ts";
import { runKanthord } from "./test-support.ts";

const FILE_FLAG = "--file";
const NOT_FOUND = -1;
const MIN_FILE_COMMANDS = 30;
const EXAMPLE_INDENT = /^ {2}/gm;
const MAX_COMMANDS = 400;
const WHITESPACE = /\s+/g;

type FileCommand = { path: string[]; command: Command };

function fileCommands(program: Command): FileCommand[] {
  const pending: FileCommand[] = program.commands.map((command) => ({
    path: [command.name()],
    command,
  }));
  const found: FileCommand[] = [];
  for (let index = 0; index < pending.length && index < MAX_COMMANDS; index++) {
    const entry = pending[index]!;
    if (entry.command.options.some((option) => option.long === FILE_FLAG))
      found.push(entry);
    pending.push(
      ...entry.command.commands.map((command) => ({
        path: [...entry.path, command.name()],
        command,
      })),
    );
  }
  assert.ok(pending.length < MAX_COMMANDS);
  return found;
}

function environment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KANTHORD_CONFIG: join(directory, "kanthord.yaml"),
    XDG_CONFIG_HOME: directory,
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
    KANTHORD_ENDPOINT: undefined,
    KANTHORD_TOKEN: undefined,
  };
}

test("every command with a --file option prints a body example that its schema accepts", async (t) => {
  const env = environment(temporary(t));
  const commands = fileCommands(createProgram());
  assert.ok(commands.length >= MIN_FILE_COMMANDS);
  for (const { path, command } of commands) {
    const label = path.join(" ");
    const body = fileBodyOf(command);
    assert.ok(body, `${label}: no file body help`);
    const help = await runKanthord([...path, "--help"], env);
    assert.equal(help.code, ExitCode.Success, help.stderr);
    const marker = help.stdout.indexOf(`${EXAMPLE_MARKER}\n`);
    assert.notEqual(marker, NOT_FOUND, `${label}: no example in help`);
    const printed = help.stdout
      .slice(marker + EXAMPLE_MARKER.length + 1)
      .replace(EXAMPLE_INDENT, "");
    if (body.schema === undefined) {
      assert.equal(printed.trim(), body.example, label);
      continue;
    }
    const parsed = body.schema.safeParse(JSON.parse(printed));
    assert.ok(parsed.success, `${label}: ${JSON.stringify(parsed.error)}`);
  }
});

test("config init help names the default and the container value of --gateway-bind", async (t) => {
  const env = environment(temporary(t));
  const help = await runKanthord(["config", "init", "--help"], env);
  assert.equal(help.code, ExitCode.Success, help.stderr);
  assert.match(
    help.stdout.replace(WHITESPACE, " "),
    /default: 127\.0\.0\.1; use :: in a container/,
  );
});
