import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  NODE_IDENTITY_PREFIX,
  proposalDecideSchema,
} from "../../mission/contract.ts";
import { singleUse } from "./shared.ts";
import {
  addMutationOptions,
  addPagination,
  client,
  mutate,
  pagination,
  printResult,
} from "./mission-support.ts";
import { missionExamples } from "./mission-examples.ts";

const MIN_ATTEMPT_FILTER = 0;
const LIST_INVALID_NODE_ID = "cli.mission.proposal.list.invalid_node_id";
const LIST_INVALID_ATTEMPT = "cli.mission.proposal.list.invalid_attempt";
const DECIDE_INVALID_ASSESSMENT_ID =
  "cli.mission.proposal.decide.invalid_assessment_id";

function attemptFilter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < MIN_ATTEMPT_FILTER ||
    String(number) !== value
  )
    throw new Diagnostic(LIST_INVALID_ATTEMPT, "invalid attempt");
  return number;
}

export function addProposalCommands(mission: Command): void {
  const proposal = mission
    .command("proposal")
    .description("Mission fix-node proposals");
  proposal.action(() => proposal.help());
  addPagination(
    proposal
      .command("list")
      .description("List the fix-node proposals of an examine node as JSON")
      .argument("<node-id>", "Node ID")
      .option("--attempt <attempt>", "Attempt filter", singleUse("--attempt")),
  ).action(async (nodeId: string, _options, command: Command) => {
    if (!identitySchema(NODE_IDENTITY_PREFIX).safeParse(nodeId).success)
      throw new Diagnostic(LIST_INVALID_NODE_ID, "invalid node ID");
    const options = command.optsWithGlobals();
    const attempt = attemptFilter(options.attempt);
    printResult(
      await client(command, "proposal.list")["proposal.list"]({
        params: { node_id: nodeId },
        query: {
          ...pagination(options),
          ...(attempt === undefined ? {} : { attempt }),
        },
        body: null,
      }),
      "proposal.list",
    );
  });
  addMutationOptions(
    proposal
      .command("decide")
      .description(
        "Decide every fix-node proposal of one assessment and unblock its examine proposer",
      )
      .argument("<assessment-id>", "Assessment ID"),
    { schema: proposalDecideSchema, example: missionExamples.proposalDecide },
  ).action(async (assessmentId: string, _options, command: Command) => {
    if (!identitySchema("assessment").safeParse(assessmentId).success)
      throw new Diagnostic(
        DECIDE_INVALID_ASSESSMENT_ID,
        "invalid assessment ID",
      );
    await mutate(
      command,
      "proposal.decide",
      proposalDecideSchema,
      (api, body, key) =>
        api["proposal.decide"](
          { params: { assessment_id: assessmentId }, query: {}, body },
          { idempotencyKey: key },
        ),
    );
  });
}
