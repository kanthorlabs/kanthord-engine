import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { formatRows } from "../../kernel/rows.ts";
import {
  httpClient,
  resolveClient,
  validateClientEndpoint,
} from "../../gateway/client.ts";
import { requireTokenTerminal } from "../../gateway/auth/jwt.ts";
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  instanceConfigurationValue,
  instanceNameSchema,
  workerOperations,
  WorkerErrorCode,
  type InstanceConfiguration,
} from "../../worker/contract.ts";
import {
  decodeInstanceConfiguration,
  instanceFilePath,
  writeInstanceFile,
  CONFIG_EXISTS,
} from "../worker/instance-config.ts";
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
const QUERY_TRUE = "true";
const QUERY_FALSE = "false";
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const REVISION_INVALID = "cli.worker.instance.revision_invalid";
const KeyOperation = {
  Create: "instance.create",
  Rotate: "instance.rotate",
} as const;
type KeyOperation = (typeof KeyOperation)[keyof typeof KeyOperation];

interface KeyedOptions {
  workerEndpoint?: string;
  output?: boolean;
  force?: boolean;
  idempotencyKey?: string;
}

function refuseName(name: string): void {
  if (!instanceNameSchema.safeParse(name).success)
    throw new Diagnostic(
      WorkerErrorCode.InstanceNameInvalid,
      "worker instance: the name breaks the binding name form or is reserved.",
    );
}

function refuseForceWithoutOutput(options: KeyedOptions): void {
  if (options.force && !options.output)
    throw new Diagnostic(
      "cli.worker.instance.force_without_output",
      "worker instance: --force requires --output.",
    );
}

function refuseExistingFile(name: string, options: KeyedOptions): void {
  if (!options.output || options.force) return;
  const path = instanceFilePath(process.env, name);
  if (audit(path, FileKind.File, true))
    throw new Diagnostic(
      CONFIG_EXISTS,
      "worker instance: the instance file exists. Pass --force to overwrite it.",
      { fields: [["path", path]] },
    );
}

function publish(
  record: Record<string, unknown>,
  configuration: InstanceConfiguration,
  options: KeyedOptions,
): void {
  if (options.output) {
    const path = writeInstanceFile(process.env, configuration, !!options.force);
    process.stdout.write(`${JSON.stringify({ ...record, created: path })}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      ...record,
      instance_configuration: instanceConfigurationValue(configuration),
    })}\n`,
  );
}

async function keyed(
  name: string,
  command: Command,
  operation: KeyOperation,
  body: (publicKey: string) => Record<string, unknown>,
): Promise<void> {
  const options = command.optsWithGlobals<
    KeyedOptions & { endpoint?: string; token?: string }
  >();
  refuseName(name);
  refuseForceWithoutOutput(options);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, `cli.worker.${operation}.token_required`);
  const workerEndpoint = options.workerEndpoint ?? endpoint;
  validateClientEndpoint(workerEndpoint);
  refuseExistingFile(name, options);
  if (!options.output) requireTokenTerminal(process.stdout);
  const key = resolveKey(options);
  const pair = await generateX25519KeyPair();
  try {
    const client = httpClient(workerOperations, endpoint, token);
    const input = {
      params: operation === KeyOperation.Rotate ? { instance_name: name } : {},
      query: {},
      body: body(pair.public_key.toString(BASE64URL)),
    };
    const result =
      operation === KeyOperation.Create
        ? await client["instance.create"](
            input as Parameters<(typeof client)["instance.create"]>[0],
            { idempotencyKey: key },
          )
        : await client["instance.rotate"](
            input as Parameters<(typeof client)["instance.rotate"]>[0],
            { idempotencyKey: key },
          );
    const record = handleMutationResult(
      result,
      `cli.worker.${operation}.indeterminate`,
      key,
    );
    publish(
      record,
      {
        name: record.name,
        endpoint: workerEndpoint,
        instance_id: record.id,
        private_key: pair.private_key.toString(BASE64URL),
      },
      options,
    );
  } finally {
    pair.private_key.fill(0);
  }
}

function parseRevision(value: string | undefined): number {
  if (value === undefined)
    throw new Diagnostic(REVISION_INVALID, "--expected-revision is required");
  return parsePositiveInt(value, REVISION_INVALID);
}

async function list(command: Command): Promise<void> {
  assert.equal(workerOperations["instance.list"].access, AccessPolicy.Human);
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
  requireToken(token, "cli.worker.instance.list.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "instance.list"
  ]({
    params: {},
    query: {
      limit,
      include_archived: options.includeArchived ? QUERY_TRUE : QUERY_FALSE,
      ...(options.worker === undefined ? {} : { worker: options.worker }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.instance.list.indeterminate"))}\n`,
  );
}

async function get(name: string, command: Command): Promise<void> {
  assert.equal(workerOperations["instance.get"].access, AccessPolicy.Human);
  refuseName(name);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.worker.instance.get.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "instance.get"
  ]({ params: { instance_name: name }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.instance.get.indeterminate"))}\n`,
  );
}

async function archive(name: string, command: Command): Promise<void> {
  assert.equal(workerOperations["instance.archive"].access, AccessPolicy.Human);
  refuseName(name);
  const options = command.optsWithGlobals();
  const expected = parseRevision(options.expectedRevision);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.instance.archive.token_required");
  const key = resolveKey(options);
  const result = await httpClient(workerOperations, endpoint, token)[
    "instance.archive"
  ](
    {
      params: { instance_name: name },
      query: {},
      body: { expected_revision: expected },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    "cli.worker.instance.archive.indeterminate",
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

function join(command: Command): void {
  const options = command.optsWithGlobals();
  const configuration = decodeInstanceConfiguration(
    readFileSync(STDIN_DESCRIPTOR, "utf8"),
  );
  const path = writeInstanceFile(process.env, configuration, !!options.force);
  process.stdout.write(formatRows([["created", path]]));
}

function keyedOptions(command: Command): Command {
  return command
    .option(
      "--worker-endpoint <url>",
      "Server address that the instance calls (default: the resolved --endpoint)",
      singleUse("--worker-endpoint"),
    )
    .option(
      "--output",
      "Write the instance file workers/<name>.yaml on this host instead of printing the instance configuration",
    )
    .option("--force", "Overwrite an existing instance file (with --output)")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION));
}

export function addWorkerInstanceCommands(worker: Command): void {
  const instance = worker
    .command("instance")
    .description("Worker instance commands");
  instance.action(() => instance.help());
  keyedOptions(
    instance
      .command("create")
      .description(
        "Create a worker instance with a key pair generated on this host",
      )
      .argument("<name>", "Instance name")
      .requiredOption(
        "--worker <worker>",
        "Hosted worker name",
        singleUse("--worker"),
      ),
  ).action((name: string, _options, command: Command) =>
    keyed(name, command, KeyOperation.Create, (publicKey) => ({
      name,
      worker: command.optsWithGlobals().worker,
      public_key: publicKey,
    })),
  );
  instance
    .command("list")
    .description("List worker instances as JSON")
    .option("--worker <worker>", "Hosted worker name", singleUse("--worker"))
    .option("--include-archived", "Include archived instances")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  instance
    .command("get")
    .description("Read a worker instance as JSON")
    .argument("<name>", "Instance name")
    .action((name: string, _options, command: Command) => get(name, command));
  keyedOptions(
    instance
      .command("rotate")
      .description(
        "Reset the key of a worker instance with a key pair generated on this host",
      )
      .argument("<name>", "Instance name")
      .option(
        "--expected-revision <revision>",
        "Live revision of the instance",
        singleUse("--expected-revision"),
      ),
  ).action((name: string, _options, command: Command) =>
    keyed(name, command, KeyOperation.Rotate, (publicKey) => ({
      public_key: publicKey,
      expected_revision: parseRevision(
        command.optsWithGlobals().expectedRevision,
      ),
    })),
  );
  instance
    .command("archive")
    .description("Archive a worker instance and end its registrations")
    .argument("<name>", "Instance name")
    .option(
      "--expected-revision <revision>",
      "Live revision of the instance",
      singleUse("--expected-revision"),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((name: string, _options, command: Command) =>
      archive(name, command),
    );
  worker
    .command("join")
    .description(
      "Write the instance file workers/<name>.yaml from the instance configuration on standard input",
    )
    .option("--force", "Overwrite an existing instance file")
    .action((_options, command: Command) => join(command));
}
