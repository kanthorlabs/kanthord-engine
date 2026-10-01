import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { AssetKind, evidenceSubmitSchema } from "../../mission/contract.ts";
import {
  addMutationOptions,
  mutate,
  addPagination,
  client,
  pagination,
  printResult,
} from "./mission-support.ts";
import {
  singleUse,
  parsePositiveInt,
  resolveKey,
  handleMutationResult,
} from "./shared.ts";

const ZERO = 0;

function addDeleteOptions(command: Command): Command {
  return command
    .requiredOption(
      "--expected-mission-version <version>",
      "Expected mission version",
      singleUse("--expected-mission-version"),
    )
    .option("--force", "Force deletion", singleUse("--force"))
    .option("--reason <text>", "Deletion reason", singleUse("--reason"))
    .option(
      "--idempotency-key <key>",
      "Mutation key",
      singleUse("--idempotency-key"),
    );
}

function deleteBody(
  options: { expectedMissionVersion: string; force?: boolean; reason?: string },
  code: string,
) {
  return {
    expectedMissionVersion: parsePositiveInt(
      options.expectedMissionVersion,
      code,
    ),
    force: options.force ?? false,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };
}

export function addEvidenceCommands(mission: Command): void {
  const evidence = mission.command("evidence").description("Mission evidence");
  evidence.action(() => evidence.help());
  addEvidenceReads(evidence);
  const asset = evidence.command("asset").description("Evidence assets");
  asset.action(() => asset.help());
  addDeleteOptions(
    asset.command("delete").argument("<asset-id>", "Asset ID"),
  ).action(async (assetId: string, _options, command: Command) => {
    if (!identitySchema("evidence_asset").safeParse(assetId).success)
      throw new Diagnostic(
        "cli.mission.evidence.asset.delete.invalid_asset_id",
        "invalid asset ID",
      );
    const options = command.optsWithGlobals<{
      expectedMissionVersion: string;
      force?: boolean;
      reason?: string;
      idempotencyKey?: string;
    }>();
    const body = deleteBody(
      options,
      "cli.mission.evidence.asset.delete.invalid_expected_mission_version",
    );
    const key = resolveKey(options);
    const result = await client(command, "evidence.asset.delete")[
      "evidence.asset.delete"
    ]({ params: { assetId }, query: {}, body }, { idempotencyKey: key });
    handleMutationResult(
      result,
      "cli.mission.evidence.asset.delete.indeterminate",
      key,
    );
    process.stdout.write(`${JSON.stringify({ idempotencyKey: key })}\n`);
  });
  const content = asset.command("content").description("Stored asset content");
  content.action(() => content.help());
  content
    .command("get")
    .argument("<asset-id>", "Evidence asset ID")
    .action(async (assetId: string, _options, command: Command) => {
      if (!identitySchema("evidence_asset").safeParse(assetId).success)
        throw new Diagnostic(
          "cli.mission.evidence.asset.content.get.invalid_asset_id",
          "invalid asset ID",
        );
      printResult(
        await client(command, "evidence.asset.content.get")[
          "evidence.asset.content.get"
        ]({ params: { assetId }, query: {}, body: null }),
        "evidence.asset.content.get",
      );
    });
  addMutationOptions(
    evidence.command("submit").argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema("node").safeParse(nodeId).success)
      throw new Diagnostic(
        "cli.mission.evidence.submit.invalid_node_id",
        "invalid node ID",
      );
    await mutate(
      command,
      "evidence.submit",
      evidenceSubmitSchema,
      (api, body, key) => {
        if (body.assets.some((asset) => asset.kind === AssetKind.Object))
          throw new Diagnostic(
            "cli.mission.evidence.submit.object_asset",
            "Use the host upload helper for object assets.",
          );
        return api["evidence.submit"](
          { params: { nodeId }, query: {}, body },
          { idempotencyKey: key },
        );
      },
    );
  });
}

function addEvidenceReads(evidence: Command): void {
  addPagination(
    evidence
      .command("list")
      .argument("<node-id>", "Node ID")
      .option("--attempt <attempt>", "Attempt filter", singleUse("--attempt")),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema("node").safeParse(nodeId).success)
      throw new Diagnostic(
        "cli.mission.evidence.list.invalid_node_id",
        "invalid node ID",
      );
    const options = command.optsWithGlobals();
    const attempt =
      options.attempt === undefined ? undefined : Number(options.attempt);
    if (
      attempt !== undefined &&
      (!Number.isSafeInteger(attempt) ||
        attempt < ZERO ||
        String(attempt) !== options.attempt)
    )
      throw new Diagnostic(
        "cli.mission.evidence.list.invalid_attempt",
        "invalid attempt",
      );
    printResult(
      await client(command, "evidence.list")["evidence.list"]({
        params: { nodeId },
        query: {
          ...pagination(options),
          ...(attempt === undefined ? {} : { attempt }),
        },
        body: null,
      }),
      "evidence.list",
    );
  });
  evidence
    .command("get")
    .argument("<evidence-id>", "Evidence ID")
    .action(async (evidenceId: string, _options, command: Command) => {
      if (!identitySchema("evidence").safeParse(evidenceId).success)
        throw new Diagnostic(
          "cli.mission.evidence.get.invalid_evidence_id",
          "invalid evidence ID",
        );
      printResult(
        await client(command, "evidence.get")["evidence.get"]({
          params: { evidenceId },
          query: {},
          body: null,
        }),
        "evidence.get",
      );
    });
}
