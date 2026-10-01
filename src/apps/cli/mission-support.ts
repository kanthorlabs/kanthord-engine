import type { Command } from "commander";
import type { z } from "zod";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import type { OperationResult } from "../../kernel/operation.ts";
import {
  missionOperations,
  NODE_LIST_LIMIT_DEFAULT,
  NODE_LIST_LIMIT_MAX,
} from "../../mission/contract.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const FILE_OPTION = "--file";
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
type ReadCommand = keyof typeof missionOperations;

export function client(command: Command, name: ReadCommand) {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(
    token,
    `cli.mission.${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}.token_required`,
  );
  return httpClient(missionOperations, endpoint, token);
}

export function printResult<T>(
  result: OperationResult<T>,
  name: ReadCommand,
): void {
  const data = handleReadResult(
    result,
    `cli.mission.${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}.indeterminate`,
  );
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export function pagination(options: { limit?: string; cursor?: string }) {
  const limit =
    options.limit === undefined
      ? NODE_LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > NODE_LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${NODE_LIST_LIMIT_MAX}`,
    );
  return {
    limit,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
}

export async function mutate<S extends z.ZodTypeAny, T extends object>(
  command: Command,
  name: string,
  schema: S,
  invoke: (
    api: ReturnType<typeof httpClient<typeof missionOperations>>,
    body: z.infer<S>,
    key: string,
  ) => Promise<OperationResult<T>>,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, `cli.mission.${name}.token_required`);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, schema);
  const result = await invoke(
    httpClient(missionOperations, endpoint, token),
    body,
    key,
  );
  const data = handleMutationResult(
    result,
    `cli.mission.${name}.indeterminate`,
    key,
  );
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

export function addPagination(command: Command): Command {
  return command
    .option(
      "--limit <count>",
      "Maximum results per page (default: 100, range: 1..1000)",
      singleUse("--limit"),
    )
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    );
}

export function addMutationOptions(command: Command): Command {
  return command
    .requiredOption(
      FILE_OPTION + " <path>",
      "Node JSON file",
      singleUse(FILE_OPTION),
    )
    .option(KEY_OPTION + " <key>", "Mutation key", singleUse(KEY_OPTION));
}
