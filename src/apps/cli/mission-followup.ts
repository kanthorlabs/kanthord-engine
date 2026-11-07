import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  followupDecideSchema,
  NODE_IDENTITY_PREFIX,
} from "../../mission/contract.ts";
import {
  addMutationOptions,
  addPagination,
  client,
  mutate,
  pagination,
  printResult,
} from "./mission-support.ts";
import { missionExamples } from "./mission-examples.ts";

const LIST_INVALID_PROJECT_ID = "cli.mission.followup.list.invalid_project_id";
const DECIDE_INVALID_NODE_ID = "cli.mission.followup.decide.invalid_node_id";

export function addFollowupCommands(mission: Command): void {
  const followup = mission
    .command("followup")
    .description("Mission follow-up proposals of terminal nodes");
  followup.action(() => followup.help());
  addPagination(
    followup
      .command("list")
      .description("List the open follow-up proposals of a project as JSON")
      .argument("<project-id>", "Project ID"),
  ).action(async (projectId: string, _options, command: Command) => {
    if (!identitySchema("project").safeParse(projectId).success)
      throw new Diagnostic(LIST_INVALID_PROJECT_ID, "invalid project ID");
    printResult(
      await client(command, "followup.list")["followup.list"]({
        params: { project_id: projectId },
        query: pagination(command.optsWithGlobals()),
        body: null,
      }),
      "followup.list",
    );
  });
  addMutationOptions(
    followup
      .command("decide")
      .description(
        "Approve the open follow-up proposal of a terminal node into a follow-up node, or reject it",
      )
      .argument("<node-id>", "Node ID"),
    { schema: followupDecideSchema, example: missionExamples.followupDecide },
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema(NODE_IDENTITY_PREFIX).safeParse(nodeId).success)
      throw new Diagnostic(DECIDE_INVALID_NODE_ID, "invalid node ID");
    await mutate(
      command,
      "followup.decide",
      followupDecideSchema,
      (api, body, key) =>
        api["followup.decide"](
          { params: { node_id: nodeId }, query: {}, body },
          { idempotencyKey: key },
        ),
    );
  });
}
