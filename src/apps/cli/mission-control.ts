import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  humanActSchema,
  resumeSchema,
  overrideSchema,
  unblockSchema,
  AssessmentResult,
} from "../../mission/contract.ts";
import { singleUse } from "./shared.ts";
import { addMutationOptions, mutate } from "./mission-support.ts";

const PAUSE_INVALID_NODE = "cli.mission.node.pause.invalid_node_id";

export function addControlCommands(node: Command): void {
  addUnblockCommand(node);
  addOverrideCommand(node);
  for (const [name, operation, code] of [
    ["block", "node.block", "cli.mission.node.block.invalid_node_id"],
    ["discard", "node.discard", "cli.mission.node.discard.invalid_node_id"],
  ] as const) {
    addMutationOptions(
      node
        .command(name)
        .description(`${name} a mission node`)
        .argument("<node-id>", "Node ID"),
    ).action(async (nodeId: string, _options, command: Command) => {
      if (!identitySchema("node").safeParse(nodeId).success)
        throw new Diagnostic(code, "invalid node ID");
      await mutate(command, operation, humanActSchema, (api, body, key) =>
        api[operation](
          { params: { nodeId }, query: {}, body },
          { idempotencyKey: key },
        ),
      );
    });
  }
  addMutationOptions(
    node
      .command("ready")
      .description("Mark a node ready for evaluation")
      .argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema("node").safeParse(nodeId).success)
      throw new Diagnostic(
        "cli.mission.node.ready.invalid_node_id",
        "invalid node ID",
      );
    await mutate(command, "node.ready", humanActSchema, (api, body, key) =>
      api["node.ready"](
        { params: { nodeId }, query: {}, body },
        { idempotencyKey: key },
      ),
    );
  });
  addMutationOptions(
    node
      .command("resume")
      .description("Resume a paused node")
      .argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema("node").safeParse(nodeId).success)
      throw new Diagnostic(
        "cli.mission.node.resume.invalid_node_id",
        "invalid node ID",
      );
    await mutate(command, "node.resume", resumeSchema, (api, body, key) =>
      api["node.resume"](
        { params: { nodeId }, query: {}, body },
        { idempotencyKey: key },
      ),
    );
  });
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

function addUnblockCommand(node: Command): void {
  addMutationOptions(
    node
      .command("unblock")
      .description("Unblock a node")
      .argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema("node").safeParse(nodeId).success)
      throw new Diagnostic(
        "cli.mission.node.unblock.invalid_node_id",
        "invalid node ID",
      );
    await mutate(command, "node.unblock", unblockSchema, (api, body, key) =>
      api["node.unblock"](
        { params: { nodeId }, query: {}, body },
        { idempotencyKey: key },
      ),
    );
  });
}

function addOverrideCommand(node: Command): void {
  addMutationOptions(
    node
      .command("override")
      .description("Assert node success")
      .argument("<node-id>", "Node ID")
      .requiredOption("--result <result>", "success", singleUse("--result")),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema("node").safeParse(nodeId).success)
      throw new Diagnostic(
        "cli.mission.node.override.invalid_node_id",
        "invalid node ID",
      );
    if (command.optsWithGlobals().result !== AssessmentResult.Success)
      throw new Diagnostic(
        "cli.mission.node.override.invalid_result",
        "result must be success",
      );
    await mutate(
      command,
      "node.override",
      overrideSchema.omit({ result: true }),
      (api, body, key) =>
        api["node.override"](
          {
            params: { nodeId },
            query: {},
            body: { ...body, result: AssessmentResult.Success },
          },
          { idempotencyKey: key },
        ),
    );
  });
}
