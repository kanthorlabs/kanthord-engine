import assert from "node:assert/strict";
import { Command } from "commander";
import { ulid } from "ulid";
import { Diagnostic } from "../../kernel/errors.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { workerOperations } from "../../worker/contract.ts";
import { resolveClient } from "./client-config.ts";

async function register(command: Command): Promise<void> {
  assert.equal(workerOperations.register.access, AccessPolicy.Client);
  assert.equal(workerOperations.register.requiresRegistration, false);
  const options = command.optsWithGlobals();
  const config = resolveClient(options);
  if (!config.token?.trim())
    throw new Diagnostic(
      "cli.worker.register.token_required",
      "worker register: supply a machine JWT through --token, KANTHORD_TOKEN or cli.yaml.",
    );
  const key = options.idempotencyKey ?? ulid();
  if (!ulidSchema.safeParse(key).success)
    throw new Diagnostic(
      "cli.worker.register.invalid_idempotency_key",
      "worker register: --idempotency-key must be a canonical ULID.",
    );
  const result = await httpClient(
    workerOperations,
    config.endpoint,
    config.token,
  ).register({ params: {}, query: {}, body: null }, { idempotencyKey: key });
  if (result.type === OperationResultType.Indeterminate)
    throw new Diagnostic(
      "cli.worker.register.indeterminate",
      `worker register: result is indeterminate; retry with --idempotency-key ${key}.`,
    );
  if (result.type === OperationResultType.Failure)
    throw new Diagnostic(
      result.error.error.code,
      `worker register: request failed (HTTP ${result.status}); idempotency key ${key}.`,
    );
  process.stdout.write(
    `${JSON.stringify({ ...result.data, idempotencyKey: key })}\n`,
  );
}

export function addWorkerCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Worker),
  );
  const worker = program
    .command(CommandName.Worker)
    .description("Worker Service commands")
    .option("--endpoint <url>", "Server endpoint");
  worker.action(() => worker.help());
  worker
    .command("register")
    .description(
      "Register a worker instance with a machine JWT and print its runtime identity and idempotency key as JSON",
    )
    .option(
      "--token <jwt>",
      "Machine JWT (otherwise KANTHORD_TOKEN or an operator-supplied client file)",
    )
    .option(
      "--idempotency-key <ulid>",
      "Reuse this key when retrying the same registration; generated when omitted",
    )
    .action((_options, command: Command) => register(command));
}
