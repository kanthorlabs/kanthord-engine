import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { actionKeySchema } from "../../mission/contract.ts";
import { singleUse } from "./shared.ts";
import {
  client,
  printResult,
  pagination,
  addPagination,
} from "./mission-support.ts";

const ZERO = 0;
const ONE = 1;
function validateNode(nodeId: string, code: string): void {
  if (!identitySchema("node").safeParse(nodeId).success)
    throw new Diagnostic(code, "invalid node ID");
}
function numberArgument(value: string, code: string, min: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || String(number) !== value)
    throw new Diagnostic(code, "invalid attempt");
  return number;
}

export function addRecordCommands(mission: Command): void {
  const attempts = mission
    .command("attempt")
    .description("Mission attempt records");
  attempts.action(() => attempts.help());
  addPagination(
    attempts.command("list").argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    validateNode(nodeId, "cli.mission.attempt.list.invalid_node_id");
    printResult(
      await client(command, "attempt.list")["attempt.list"]({
        params: { nodeId },
        query: pagination(command.optsWithGlobals()),
        body: null,
      }),
      "attempt.list",
    );
  });
  attempts
    .command("get")
    .argument("<node-id>", "Node ID")
    .argument("<attempt>", "Positive attempt")
    .action(
      async (nodeId: string, value: string, _options, command: Command) => {
        validateNode(nodeId, "cli.mission.attempt.get.invalid_node_id");
        const attempt = numberArgument(
          value,
          "cli.mission.attempt.get.invalid_attempt",
          ONE,
        );
        printResult(
          await client(command, "attempt.get")["attempt.get"]({
            params: { nodeId, attempt },
            query: {},
            body: null,
          }),
          "attempt.get",
        );
      },
    );
  addExternalCommands(mission);
}

function addExternalCommands(mission: Command): void {
  const actions = mission
    .command("external-action")
    .description("Required external actions");
  actions.action(() => actions.help());
  addPagination(
    actions
      .command("list")
      .argument("<node-id>", "Node ID")
      .option("--attempt <attempt>", "Attempt filter", singleUse("--attempt")),
  ).action(async (nodeId: string, _options, command: Command) => {
    validateNode(nodeId, "cli.mission.external_action.list.invalid_node_id");
    const options = command.optsWithGlobals();
    const attempt =
      options.attempt === undefined
        ? undefined
        : numberArgument(
            options.attempt,
            "cli.mission.external_action.list.invalid_attempt",
            ZERO,
          );
    printResult(
      await client(command, "externalAction.list")["externalAction.list"]({
        params: { nodeId },
        query: { ...pagination(options), attempt },
        body: null,
      }),
      "externalAction.list",
    );
  });
  actions
    .command("get")
    .argument("<node-id>", "Node ID")
    .argument("<attempt>", "Positive attempt")
    .argument("<action-key>", "Required action key")
    .action(
      async (
        nodeId: string,
        value: string,
        actionKey: string,
        _options,
        command: Command,
      ) => {
        validateNode(nodeId, "cli.mission.external_action.get.invalid_node_id");
        const attempt = numberArgument(
          value,
          "cli.mission.external_action.get.invalid_attempt",
          ONE,
        );
        if (!actionKeySchema.safeParse(actionKey).success)
          throw new Diagnostic(
            "cli.mission.external_action.get.invalid_action_key",
            "invalid action key",
          );
        printResult(
          await client(command, "externalAction.get")["externalAction.get"]({
            params: { nodeId, attempt, actionKey },
            query: {},
            body: null,
          }),
          "externalAction.get",
        );
      },
    );
}
