import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { AssetKind, evidenceSubmitSchema } from "../../mission/contract.ts";
import { addMutationOptions, mutate } from "./mission-support.ts";

export function addEvidenceCommands(mission: Command): void {
  const evidence = mission.command("evidence").description("Mission evidence");
  evidence.action(() => evidence.help());
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
