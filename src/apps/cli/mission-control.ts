import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { humanActSchema } from "../../mission/contract.ts";
import { addMutationOptions, mutate } from "./mission-support.ts";

const PAUSE_INVALID_NODE = "cli.mission.node.pause.invalid_node_id";

export function addControlCommands(node: Command): void {
  addMutationOptions(
    node
      .command("pause")
      .description("Pause a mission node")
      .argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema("node").safeParse(nodeId).success)
      throw new Diagnostic(PAUSE_INVALID_NODE, "invalid node ID");
    await mutate(command, "node.pause", humanActSchema, (api, body, key) =>
      api["node.pause"](
        { params: { nodeId }, query: {}, body },
        { idempotencyKey: key },
      ),
    );
  });
}
