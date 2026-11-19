import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { workerOperations } from "../../worker/contract.ts";
import {
  checkSeedFolder,
  tasksDiagnostic,
  TasksErrorCode,
  writeSeed,
} from "../worker/index.ts";
import { handleReadResult, requireToken } from "./shared.ts";

const SEED_OPERATION = workerOperations["execution.seed.get"];
const TOKEN_REQUIRED = "cli.worker.tasks.seed.token_required";
const INDETERMINATE = "cli.worker.tasks.seed.indeterminate";
const NEWLINE = "\n";

export interface TasksSeedOptions {
  output: string;
  force?: boolean;
}

export async function tasksSeed(
  executionId: string,
  command: Command,
): Promise<void> {
  assert.equal(SEED_OPERATION.access, AccessPolicy.Human);
  assert.equal(SEED_OPERATION.mutation, false);
  if (!identitySchema("execution").safeParse(executionId).success)
    throw tasksDiagnostic(
      TasksErrorCode.OptionInvalid,
      "worker tasks seed: the execution id is invalid.",
      [["option", "execution_id"]],
    );
  const options = command.optsWithGlobals();
  const { output: folder, force } = options as TasksSeedOptions;
  const output = resolve(process.cwd(), folder);
  checkSeedFolder(output, !!force);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, TOKEN_REQUIRED);
  const seed = handleReadResult(
    await httpClient(workerOperations, endpoint, token)["execution.seed.get"]({
      params: { execution_id: executionId },
      query: {},
      body: null,
    }),
    INDETERMINATE,
  );
  const seedDigest = writeSeed(output, seed);
  process.stdout.write(
    `${JSON.stringify({ output, seed_digest: seedDigest })}${NEWLINE}`,
  );
}
