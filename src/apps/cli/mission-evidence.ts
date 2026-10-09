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

const MIN_ATTEMPT_VALUE = 0;

function addDeleteOptions(command: Command): Command {
  return command
    .requiredOption(
      "--expected-mission-version <version>",
      "Expected mission version",
      singleUse("--expected-mission-version"),
    )
    .option("--force", "Force deletion", false)
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
    expected_mission_version: parsePositiveInt(
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
  addDeleteOptions(
    evidence
      .command("delete")
      .description("Delete an evidence record and its stored assets")
      .argument("<evidence-id>", "Evidence ID"),
  ).action(async (evidenceId: string, _options, command: Command) => {
    if (!identitySchema("evidence").safeParse(evidenceId).success)
      throw new Diagnostic(
        "cli.mission.evidence.delete.invalid_evidence_id",
        "invalid evidence ID",
      );
    const options = command.optsWithGlobals<{
      expectedMissionVersion: string;
      force?: boolean;
      reason?: string;
      idempotencyKey?: string;
    }>();
    const body = deleteBody(
      options,
      "cli.mission.evidence.delete.invalid_expected_mission_version",
    );
    const key = resolveKey(options);
    const result = await client(command, "evidence.delete")["evidence.delete"](
      { params: { evidence_id: evidenceId }, query: {}, body },
      { idempotencyKey: key },
    );
    handleMutationResult(
      result,
      "cli.mission.evidence.delete.indeterminate",
      key,
    );
    process.stdout.write(`${JSON.stringify({ idempotency_key: key })}\n`);
  });
  const asset = evidence.command("asset").description("Evidence assets");
  asset.action(() => asset.help());
  addDeleteOptions(
    asset
      .command("delete")
      .description("Delete an evidence asset and its stored content")
      .argument("<asset-id>", "Asset ID"),
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
    ](
      { params: { asset_id: assetId }, query: {}, body },
      { idempotencyKey: key },
    );
    handleMutationResult(
      result,
      "cli.mission.evidence.asset.delete.indeterminate",
      key,
    );
    process.stdout.write(`${JSON.stringify({ idempotency_key: key })}\n`);
  });
  const content = asset.command("content").description("Stored asset content");
  content.action(() => content.help());
  content
    .command("get")
    .description("Get the stored content of an evidence asset")
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
        ]({ params: { asset_id: assetId }, query: {}, body: null }),
        "evidence.asset.content.get",
      );
    });
  addMutationOptions(
    evidence
      .command("submit")
      .description("Submit evidence for a node")
      .argument("<node-id>", "Node ID"),
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
          { params: { node_id: nodeId }, query: {}, body },
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
      .description("List the evidence of a node as JSON")
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
        attempt < MIN_ATTEMPT_VALUE ||
        String(attempt) !== options.attempt)
    )
      throw new Diagnostic(
        "cli.mission.evidence.list.invalid_attempt",
        "invalid attempt",
      );
    printResult(
      await client(command, "evidence.list")["evidence.list"]({
        params: { node_id: nodeId },
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
    .description("Get an evidence record as JSON")
    .argument("<evidence-id>", "Evidence ID")
    .action(async (evidenceId: string, _options, command: Command) => {
      if (!identitySchema("evidence").safeParse(evidenceId).success)
        throw new Diagnostic(
          "cli.mission.evidence.get.invalid_evidence_id",
          "invalid evidence ID",
        );
      printResult(
        await client(command, "evidence.get")["evidence.get"]({
          params: { evidence_id: evidenceId },
          query: {},
          body: null,
        }),
        "evidence.get",
      );
    });
}
