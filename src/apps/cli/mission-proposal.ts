import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  NODE_IDENTITY_PREFIX,
  PROPOSAL_IDENTITY_PREFIX,
  proposalApproveSchema,
} from "../../mission/contract.ts";
import { singleUse } from "./shared.ts";
import {
  client,
  printResult,
  pagination,
  addPagination,
  addMutationOptions,
  mutate,
} from "./mission-support.ts";

const MIN_ATTEMPT_FILTER = 0;
const LIST_INVALID_NODE_ID = "cli.mission.proposal.list.invalid_node_id";
const LIST_INVALID_ATTEMPT = "cli.mission.proposal.list.invalid_attempt";
const APPROVE_INVALID_PROPOSAL_ID =
  "cli.mission.proposal.approve.invalid_proposal_id";

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
    .description("Mission fix-objective proposals");
  proposal.action(() => proposal.help());
  addPagination(
    proposal
      .command("list")
      .description("List the proposals of an initiative as JSON")
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
      .command("approve")
      .description("Approve a proposal and unblock its initiative")
      .argument("<proposal-id>", "Proposal ID"),
  ).action(async (proposalId: string, _options, command: Command) => {
    if (!identitySchema(PROPOSAL_IDENTITY_PREFIX).safeParse(proposalId).success)
      throw new Diagnostic(APPROVE_INVALID_PROPOSAL_ID, "invalid proposal ID");
    await mutate(
      command,
      "proposal.approve",
      proposalApproveSchema,
      (api, body, key) =>
        api["proposal.approve"](
          { params: { proposal_id: proposalId }, query: {}, body },
          { idempotencyKey: key },
        ),
    );
  });
}
