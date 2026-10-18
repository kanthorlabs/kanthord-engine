import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Command } from "commander";
import { secretSchemas } from "../../custody/contract.ts";
import type {
  CredentialPlatform,
  CredentialPlatforms,
} from "../../custody/contract.ts";
import { configurationSchemaOf } from "../../intake/configuration.ts";
import type {
  InboundKindValue,
  InboundPlatformValue,
} from "../../intake/contract.ts";
import { LLM_PLATFORMS } from "../../llm/index.ts";
import { REPOSITORY_PLATFORMS } from "../../repository/index.ts";
import { STORAGE_PLATFORMS } from "../../storage/index.ts";
import { loadConfig } from "../../config/index.ts";
import { temporary } from "../../kernel/test-support.ts";
import { ExitCode } from "./constants.ts";
import { EXAMPLE_MARKER, fileBodyOf } from "./file-body.ts";
import { OVERRIDE_STATES } from "../../mission/contract.ts";
import { createProgram } from "./index.ts";
import { missionExamples } from "./mission-examples.ts";
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

const CREDENTIAL_TABLES: Record<string, CredentialPlatforms> = {
  llm: LLM_PLATFORMS,
  repository: REPOSITORY_PLATFORMS,
  storage: STORAGE_PLATFORMS,
};
const CREDENTIAL_GROUP = "credential";
const INBOUND_CREATE = "intake inbound create";

function acceptsFields(
  platform: CredentialPlatform,
  fields: { metadata?: unknown; secret?: unknown },
): boolean {
  const metadataOk =
    !("metadata" in fields) ||
    (platform.metadata_schema === null
      ? fields.metadata === null
      : platform.metadata_schema.safeParse(fields.metadata).success);
  const secretOk =
    !("secret" in fields) ||
    secretSchemas[platform.secret_shape].safeParse(fields.secret).success;
  return metadataOk && secretOk;
}

function assertPlatformFields(
  path: string[],
  example: unknown,
  createdPlatforms: Map<string, string>,
): void {
  const label = path.join(" ");
  const fields = example as {
    platform?: string;
    metadata?: unknown;
    secret?: unknown;
    configuration?: unknown;
  };
  if (label === INBOUND_CREATE) {
    const { kind, platform, configuration } = example as {
      kind: InboundKindValue;
      platform: InboundPlatformValue;
      configuration: unknown;
    };
    const schema = configurationSchemaOf(kind, platform);
    assert.ok(schema.safeParse(configuration).success, label);
    return;
  }
  const table = CREDENTIAL_TABLES[path[0]!];
  if (path[1] !== CREDENTIAL_GROUP || table === undefined) return;
  if (fields.platform !== undefined)
    createdPlatforms.set(path[0]!, fields.platform);
  const name = fields.platform ?? createdPlatforms.get(path[0]!);
  assert.ok(name, `${label}: no create example before this command`);
  const platform = table[name];
  assert.ok(platform, `${label}: unknown platform`);
  assert.ok(acceptsFields(platform, fields), `${label}: platform fields`);
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
  const createdPlatforms = new Map<string, string>();
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
    const example: unknown = JSON.parse(printed);
    const parsed = body.schema.safeParse(example);
    assert.ok(parsed.success, `${label}: ${JSON.stringify(parsed.error)}`);
    assertPlatformFields(path, example, createdPlatforms);
  }
});

test("the node override example names a state that override accepts", () => {
  assert.ok(
    (OVERRIDE_STATES as readonly string[]).includes(
      missionExamples.override.expected_state,
    ),
  );
});

test("config init help names the default and the container value of --gateway-bind", async (t) => {
  const env = environment(temporary(t));
  const created = await runKanthord(["config", "init"], env);
  assert.equal(created.code, ExitCode.Success, created.stderr);
  const defaultBind = loadConfig(env.KANTHORD_CONFIG!).gateway.bind;
  const help = await runKanthord(["config", "init", "--help"], env);
  assert.equal(help.code, ExitCode.Success, help.stderr);
  assert.match(
    help.stdout.replace(WHITESPACE, " "),
    new RegExp(
      `default: ${defaultBind.replaceAll(".", "\\.")}; use :: in a container`,
    ),
  );
});
