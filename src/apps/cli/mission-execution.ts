import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { AssetKind } from "../../mission/contract.ts";
import {
  client,
  printResult,
  addPagination,
  pagination,
} from "./mission-support.ts";
import { handleReadResult, parsePositiveInt } from "./shared.ts";

export function addExecutionCommands(mission: Command): void {
  const execution = mission
    .command("execution")
    .description("Execution-scoped Mission reads");
  execution.action(() => execution.help());
  addRevisionReads(execution);
  addObjectiveReads(execution);
  const evidence = execution.command("evidence").description("Bound evidence");
  evidence.action(() => evidence.help());
  addPagination(
    evidence
      .command("list")
      .description("List the evidence bound to the claimed execution as JSON")
      .argument("<execution-id>", "Execution ID"),
  ).action(async (executionId: string, _options, command: Command) => {
    executionIdentity(
      executionId,
      "cli.mission.execution.evidence.list.invalid_execution_id",
    );
    printResult(
      await client(command, "execution.evidence.list")[
        "execution.evidence.list"
      ]({
        params: { execution_id: executionId },
        query: pagination(command.optsWithGlobals()),
        body: null,
      }),
      "execution.evidence.list",
    );
  });
  const cleared = execution
    .command("cleared-outcome")
    .description("Outcome cleared by an unblock");
  cleared.action(() => cleared.help());
  cleared
    .command("get")
    .description("Get the outcome that an unblock cleared as JSON")
    .argument("<execution-id>", "Execution ID")
    .action(async (executionId: string, _options, command: Command) => {
      executionIdentity(
        executionId,
        "cli.mission.execution.cleared_outcome.get.invalid_execution_id",
      );
      printResult(
        await client(command, "execution.clearedOutcome.get")[
          "execution.clearedOutcome.get"
        ]({ params: { execution_id: executionId }, query: {}, body: null }),
        "execution.clearedOutcome.get",
      );
    });
  const asset = evidence.command("asset").description("Bound assets");
  asset.action(() => asset.help());
  const content = asset.command("content").description("Bound asset content");
  content.action(() => content.help());
  content
    .command("get")
    .description("Get the content of a bound evidence asset")
    .argument("<execution-id>", "Execution ID")
    .argument("<asset-id>", "Asset ID")
    .action(
      async (
        executionId: string,
        assetId: string,
        _options,
        command: Command,
      ) => {
        if (!identitySchema("execution").safeParse(executionId).success)
          throw new Diagnostic(
            "cli.mission.execution.evidence.asset.content.get.invalid_execution_id",
            "invalid execution ID",
          );
        if (!identitySchema("evidence_asset").safeParse(assetId).success)
          throw new Diagnostic(
            "cli.mission.execution.evidence.asset.content.get.invalid_asset_id",
            "invalid asset ID",
          );
        const result = await client(
          command,
          "execution.evidence.asset.content.get",
        )["execution.evidence.asset.content.get"]({
          params: { execution_id: executionId, asset_id: assetId },
          query: {},
          body: null,
        });
        const data = handleReadResult(
          result,
          "cli.mission.execution.evidence.asset.content.get.indeterminate",
        );
        if (data.address.kind === AssetKind.Object)
          throw new Diagnostic(
            "cli.mission.execution.evidence.asset.content.get.object_content",
            "The reader component owns object downloads.",
          );
        process.stdout.write(`${JSON.stringify(data)}\n`);
      },
    );
}

function executionIdentity(executionId: string, code: string): void {
  if (!identitySchema("execution").safeParse(executionId).success)
    throw new Diagnostic(code, "invalid execution ID");
}

function addObjectiveReads(execution: Command): void {
  const objective = execution
    .command("objective")
    .description("Current child objectives");
  objective.action(() => objective.help());
  const outcome = objective
    .command("outcome")
    .description("Current objective outcomes");
  outcome.action(() => outcome.help());
  const evidence = objective
    .command("evidence")
    .description("Current objective evidence");
  evidence.action(() => evidence.help());
  for (const [group, operation, description] of [
    [
      objective,
      "execution.objective.list",
      "List the current child objectives",
    ],
    [
      outcome,
      "execution.objective.outcome.list",
      "List the current outcomes of the child objectives",
    ],
    [
      evidence,
      "execution.objective.evidence.list",
      "List the current evidence of the child objectives",
    ],
  ] as const) {
    addPagination(
      group
        .command("list")
        .description(`${description} as JSON`)
        .argument("<execution-id>", "Execution ID"),
    ).action(async (executionId: string, _options, command: Command) => {
      executionIdentity(
        executionId,
        `cli.mission.${operation}.invalid_execution_id`,
      );
      printResult<unknown>(
        await client(command, operation)[operation]({
          params: { execution_id: executionId },
          query: pagination(command.optsWithGlobals()),
          body: null,
        }),
        operation,
      );
    });
  }
}

function addRevisionReads(execution: Command): void {
  const pinned = execution
    .command("pinned-revision")
    .description("Pinned revision");
  pinned.action(() => pinned.help());
  pinned
    .command("get")
    .description("Get the node revision that the claim pins as JSON")
    .argument("<execution-id>", "Execution ID")
    .action(async (executionId: string, _options, command: Command) => {
      executionIdentity(
        executionId,
        "cli.mission.execution.pinned_revision.get.invalid_execution_id",
      );
      printResult(
        await client(command, "execution.pinnedRevision.get")[
          "execution.pinnedRevision.get"
        ]({ params: { execution_id: executionId }, query: {}, body: null }),
        "execution.pinnedRevision.get",
      );
    });
  const revision = execution.command("revision").description("Bound revisions");
  revision.action(() => revision.help());
  addPagination(
    revision
      .command("list")
      .description("List the node revisions that the claim can read as JSON")
      .argument("<execution-id>", "Execution ID"),
  ).action(async (executionId: string, _options, command: Command) => {
    executionIdentity(
      executionId,
      "cli.mission.execution.revision.list.invalid_execution_id",
    );
    printResult(
      await client(command, "execution.revision.list")[
        "execution.revision.list"
      ]({
        params: { execution_id: executionId },
        query: pagination(command.optsWithGlobals()),
        body: null,
      }),
      "execution.revision.list",
    );
  });
  revision
    .command("get")
    .description("Get a node revision that the claim can read as JSON")
    .argument("<execution-id>", "Execution ID")
    .argument("<revision>", "Revision")
    .action(
      async (
        executionId: string,
        value: string,
        _options,
        command: Command,
      ) => {
        executionIdentity(
          executionId,
          "cli.mission.execution.revision.get.invalid_execution_id",
        );
        const revision = parsePositiveInt(
          value,
          "cli.mission.execution.revision.get.invalid_revision",
        );
        printResult(
          await client(command, "execution.revision.get")[
            "execution.revision.get"
          ]({
            params: { execution_id: executionId, revision },
            query: {},
            body: null,
          }),
          "execution.revision.get",
        );
      },
    );
}
