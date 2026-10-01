import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { AssetKind } from "../../mission/contract.ts";
import { client } from "./mission-support.ts";
import { handleReadResult } from "./shared.ts";

export function addExecutionCommands(mission: Command): void {
  const execution = mission
    .command("execution")
    .description("Execution-scoped Mission reads");
  execution.action(() => execution.help());
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
