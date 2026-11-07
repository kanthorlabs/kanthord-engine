import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { formatRows } from "../../kernel/rows.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { requireTokenTerminal } from "../../gateway/auth/jwt.ts";
import {
  instanceNameSchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  type MachineConfiguration,
  machineConfigurationValue,
  WorkerErrorCode,
  workerOperations,
} from "../../worker/contract.ts";
import {
  decodeMachineConfiguration,
  MACHINE_CONFIG_EXISTS,
  MACHINE_CONFIG_INVALID,
  machineFilePath,
  writeMachineFile,
} from "../worker/index.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";
import { audit, FileKind } from "../../kernel/files.ts";

const BASE64URL = "base64url";
const STDIN_DESCRIPTOR = 0;
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const REVISION_INVALID = "cli.worker.machine.revision_invalid";
const KeyOperation = {
  Create: "machine.create",
  Rotate: "machine.rotate",
} as const;
type KeyOperation = (typeof KeyOperation)[keyof typeof KeyOperation];

interface KeyedOptions {
  output?: boolean;
  force?: boolean;
  idempotencyKey?: string;
}

function refuseName(name: string, options: KeyedOptions = {}): void {
  if (instanceNameSchema.safeParse(name).success) return;
  if (options.output)
    throw new Diagnostic(
      MACHINE_CONFIG_INVALID,
      "worker machine: the name breaks the binding name form or is reserved.",
    );
  throw new Diagnostic(
    WorkerErrorCode.MachineNameInvalid,
    "worker machine: the name breaks the binding name form or is reserved.",
  );
}

function refuseExistingFile(name: string, options: KeyedOptions): void {
  if (!options.output || options.force) return;
  const path = machineFilePath(process.env, name);
  if (audit(path, FileKind.File, true))
    throw new Diagnostic(
      MACHINE_CONFIG_EXISTS,
      "worker machine: the machine file exists. Pass --force to overwrite it.",
      { fields: [["path", path]] },
    );
}

function publish(
  record: Record<string, unknown>,
  configuration: MachineConfiguration,
  options: KeyedOptions,
): void {
  if (options.output) {
    const path = writeMachineFile(process.env, configuration, !!options.force);
    process.stdout.write(`${JSON.stringify({ ...record, created: path })}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      ...record,
      machine_configuration: machineConfigurationValue(configuration),
    })}\n`,
  );
}

function parseRevision(value: string | undefined): number {
  if (value === undefined)
    throw new Diagnostic(REVISION_INVALID, "--expected-revision is required");
  return parsePositiveInt(value, REVISION_INVALID);
}

async function keyed(
  name: string,
  command: Command,
  operation: KeyOperation,
): Promise<void> {
  const options = command.optsWithGlobals<
    KeyedOptions & {
      endpoint?: string;
      token?: string;
      expectedRevision?: string;
    }
  >();
  refuseName(name, options);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, `cli.worker.${operation}.token_required`);
  const expected =
    operation === KeyOperation.Rotate
      ? parseRevision(options.expectedRevision)
      : undefined;
  refuseExistingFile(name, options);
  if (!options.output) requireTokenTerminal(process.stdout);
  const key = resolveKey(options);
  const pair = await generateX25519KeyPair();
  try {
    const client = httpClient(workerOperations, endpoint, token);
    const publicKey = pair.public_key.toString(BASE64URL);
    const result =
      expected === undefined
        ? await client["machine.create"](
            {
              params: {},
              query: {},
              body: { name, public_key: publicKey },
            },
            { idempotencyKey: key },
          )
        : await client["machine.rotate"](
            {
              params: { machine_name: name },
              query: {},
              body: { public_key: publicKey, expected_revision: expected },
            },
            { idempotencyKey: key },
          );
    const record = handleMutationResult(
      result,
      `cli.worker.${operation}.indeterminate`,
      key,
    );
    publish(
      record,
      { name: record.name, private_key: pair.private_key.toString(BASE64URL) },
      options,
    );
  } finally {
    pair.private_key.fill(0);
  }
}

async function list(command: Command): Promise<void> {
  assert.equal(workerOperations["machine.list"].access, AccessPolicy.Human);
  const options = command.optsWithGlobals();
  const limit =
    options.limit === undefined
      ? LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${LIST_LIMIT_MAX}`,
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.machine.list.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "machine.list"
  ]({
    params: {},
    query: {
      limit,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.machine.list.indeterminate"))}\n`,
  );
}

async function get(name: string, command: Command): Promise<void> {
  assert.equal(workerOperations["machine.get"].access, AccessPolicy.Human);
  refuseName(name);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.worker.machine.get.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "machine.get"
  ]({ params: { machine_name: name }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.machine.get.indeterminate"))}\n`,
  );
}

async function archive(name: string, command: Command): Promise<void> {
  assert.equal(workerOperations["machine.archive"].access, AccessPolicy.Human);
  refuseName(name);
  const options = command.optsWithGlobals();
  const expected = parseRevision(options.expectedRevision);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.machine.archive.token_required");
  const key = resolveKey(options);
  const result = await httpClient(workerOperations, endpoint, token)[
    "machine.archive"
  ](
    {
      params: { machine_name: name },
      query: {},
      body: { expected_revision: expected },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    "cli.worker.machine.archive.indeterminate",
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

function join(command: Command): void {
  const options = command.optsWithGlobals();
  const configuration = decodeMachineConfiguration(
    readFileSync(STDIN_DESCRIPTOR, "utf8"),
  );
  const path = writeMachineFile(process.env, configuration, !!options.force);
  process.stdout.write(formatRows([["created", path]]));
}

function keyedOptions(command: Command): Command {
  return command
    .option(
      "--output",
      "Write the machine file machines/<name>.yaml on this computer instead of printing the machine configuration",
    )
    .option("--force", "Overwrite an existing machine file (with --output)")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION));
}

export function addWorkerMachineCommands(worker: Command): void {
  const machine = worker
    .command("machine")
    .description("Worker machine commands");
  machine.action(() => machine.help());
  keyedOptions(
    machine
      .command("create")
      .description(
        "Create a worker machine with a key pair generated on this computer",
      )
      .argument("<name>", "Machine name"),
  ).action((name: string, _options, command: Command) =>
    keyed(name, command, KeyOperation.Create),
  );
  machine
    .command("list")
    .description("List worker machines as JSON")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  machine
    .command("get")
    .description("Read a worker machine as JSON")
    .argument("<name>", "Machine name")
    .action((name: string, _options, command: Command) => get(name, command));
  keyedOptions(
    machine
      .command("rotate")
      .description(
        "Reset the key of a worker machine with a key pair generated on this computer",
      )
      .argument("<name>", "Machine name")
      .option(
        "--expected-revision <revision>",
        "Live revision of the machine",
        singleUse("--expected-revision"),
      ),
  ).action((name: string, _options, command: Command) =>
    keyed(name, command, KeyOperation.Rotate),
  );
  machine
    .command("archive")
    .description("Archive a worker machine that no live instance names")
    .argument("<name>", "Machine name")
    .option(
      "--expected-revision <revision>",
      "Live revision of the machine",
      singleUse("--expected-revision"),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((name: string, _options, command: Command) =>
      archive(name, command),
    );
  machine
    .command("join")
    .description(
      "Write the machine file machines/<name>.yaml from the machine configuration on standard input",
    )
    .option("--force", "Overwrite an existing machine file")
    .action((_options, command: Command) => join(command));
}
