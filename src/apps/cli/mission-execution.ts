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
  const evidence = execution.command("evidence").description("Bound evidence");
  evidence.action(() => evidence.help());
  const asset = evidence.command("asset").description("Bound assets");
  asset.action(() => asset.help());
  const content = asset.command("content").description("Bound asset content");
  content.action(() => content.help());
  content
    .command("get")
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
          params: { executionId, assetId },
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

function addRevisionReads(execution: Command): void {
  const pinned = execution
    .command("pinned-revision")
    .description("Pinned revision");
  pinned.action(() => pinned.help());
  pinned
    .command("get")
    .argument("<execution-id>", "Execution ID")
    .action(async (executionId: string, _options, command: Command) => {
      executionIdentity(
        executionId,
        "cli.mission.execution.pinned_revision.get.invalid_execution_id",
      );
      printResult(
        await client(command, "execution.pinnedRevision.get")[
          "execution.pinnedRevision.get"
        ]({ params: { executionId }, query: {}, body: null }),
        "execution.pinnedRevision.get",
      );
    });
  const revision = execution.command("revision").description("Bound revisions");
  revision.action(() => revision.help());
  addPagination(
    revision.command("list").argument("<execution-id>", "Execution ID"),
  ).action(async (executionId: string, _options, command: Command) => {
    executionIdentity(
      executionId,
      "cli.mission.execution.revision.list.invalid_execution_id",
    );
    printResult(
      await client(command, "execution.revision.list")[
        "execution.revision.list"
      ]({
        params: { executionId },
        query: pagination(command.optsWithGlobals()),
        body: null,
      }),
      "execution.revision.list",
    );
  });
  revision
    .command("get")
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
          ]({ params: { executionId, revision }, query: {}, body: null }),
          "execution.revision.get",
        );
      },
    );
}
