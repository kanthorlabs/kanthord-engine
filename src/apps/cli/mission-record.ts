import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  actionKeySchema,
  assessmentSubmitSchema,
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
const MIN_ATTEMPT_NUMBER = 1;
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
  addAssessmentCommands(mission);
  addOutcomeCommands(mission);
  const attempts = mission
    .command("attempt")
    .description("Mission attempt records");
  attempts.action(() => attempts.help());
  addPagination(
    attempts
      .command("list")
      .description("List the attempts of a node as JSON")
      .argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    validateNode(nodeId, "cli.mission.attempt.list.invalid_node_id");
    printResult(
      await client(command, "attempt.list")["attempt.list"]({
        params: { node_id: nodeId },
        query: pagination(command.optsWithGlobals()),
        body: null,
      }),
      "attempt.list",
    );
  });
  attempts
    .command("get")
    .description("Get an attempt of a node as JSON")
    .argument("<node-id>", "Node ID")
    .argument("<attempt>", "Positive attempt")
    .action(
      async (nodeId: string, value: string, _options, command: Command) => {
        validateNode(nodeId, "cli.mission.attempt.get.invalid_node_id");
        const attempt = numberArgument(
          value,
          "cli.mission.attempt.get.invalid_attempt",
          MIN_ATTEMPT_NUMBER,
        );
        printResult(
          await client(command, "attempt.get")["attempt.get"]({
            params: { node_id: nodeId, attempt },
            query: {},
            body: null,
          }),
          "attempt.get",
        );
      },
    );
  addExternalCommands(mission);
}

function recordListQuery(command: Command, code: string) {
  const options = command.optsWithGlobals();
  return {
    ...pagination(options),
    ...(options.attempt === undefined
      ? {}
      : { attempt: numberArgument(options.attempt, code, MIN_ATTEMPT_FILTER) }),
  };
}

function recordGroup(mission: Command, name: string) {
  const group = mission.command(name).description(`Mission ${name} records`);
  group.action(() => group.help());
  const list = addPagination(
    group
      .command("list")
      .description(`List the ${name} records of a node as JSON`)
      .argument("<node-id>", "Node ID")
      .option("--attempt <attempt>", "Attempt filter", singleUse("--attempt")),
  );
  const get = group
    .command("get")
    .description(`Get a ${name} record as JSON`)
    .argument(`<${name}-id>`, "Record ID");
  return { group, list, get };
}

function addAssessmentCommands(mission: Command): void {
  const { group, list, get } = recordGroup(mission, "assessment");
  addMutationOptions(
    group
      .command("submit")
      .description("Submit an assessment of a node")
      .argument("<node-id>", "Node ID"),
  ).action(async (nodeId: string, _options, command: Command) => {
    validateNode(nodeId, "cli.mission.assessment.submit.invalid_node_id");
    await mutate(
      command,
      "assessment.submit",
      assessmentSubmitSchema,
      (api, body, key) =>
        api["assessment.submit"](
          { params: { node_id: nodeId }, query: {}, body },
          { idempotencyKey: key },
        ),
    );
  });
  list.action(async (nodeId: string, _options, command: Command) => {
    validateNode(nodeId, "cli.mission.assessment.list.invalid_node_id");
    printResult(
      await client(command, "assessment.list")["assessment.list"]({
        params: { node_id: nodeId },
        query: recordListQuery(
          command,
          "cli.mission.assessment.list.invalid_attempt",
        ),
        body: null,
      }),
      "assessment.list",
    );
  });
  get.action(async (assessmentId: string, _options, command: Command) => {
    if (!identitySchema("assessment").safeParse(assessmentId).success)
      throw new Diagnostic(
        "cli.mission.assessment.get.invalid_assessment_id",
        "invalid assessment ID",
      );
    printResult(
      await client(command, "assessment.get")["assessment.get"]({
        params: { assessment_id: assessmentId },
        query: {},
        body: null,
      }),
      "assessment.get",
    );
  });
}

function addOutcomeCommands(mission: Command): void {
  const { list, get } = recordGroup(mission, "outcome");
  list.action(async (nodeId: string, _options, command: Command) => {
    validateNode(nodeId, "cli.mission.outcome.list.invalid_node_id");
    printResult(
      await client(command, "outcome.list")["outcome.list"]({
        params: { node_id: nodeId },
        query: recordListQuery(
          command,
          "cli.mission.outcome.list.invalid_attempt",
        ),
        body: null,
      }),
      "outcome.list",
    );
  });
  get.action(async (outcomeId: string, _options, command: Command) => {
    if (!identitySchema("outcome").safeParse(outcomeId).success)
      throw new Diagnostic(
        "cli.mission.outcome.get.invalid_outcome_id",
        "invalid outcome ID",
      );
    printResult(
      await client(command, "outcome.get")["outcome.get"]({
        params: { outcome_id: outcomeId },
        query: {},
        body: null,
      }),
      "outcome.get",
    );
  });
}

function addExternalCommands(mission: Command): void {
  const actions = mission
    .command("external-action")
    .description("Required external actions");
  actions.action(() => actions.help());
  addPagination(
    actions
      .command("list")
      .description("List the required external actions of a node as JSON")
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
            MIN_ATTEMPT_FILTER,
          );
    printResult(
      await client(command, "externalAction.list")["externalAction.list"]({
        params: { node_id: nodeId },
        query: { ...pagination(options), attempt },
        body: null,
      }),
      "externalAction.list",
    );
  });
  actions
    .command("get")
    .description("Get a required external action as JSON")
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
          MIN_ATTEMPT_NUMBER,
        );
        if (!actionKeySchema.safeParse(actionKey).success)
          throw new Diagnostic(
            "cli.mission.external_action.get.invalid_action_key",
            "invalid action key",
          );
        printResult(
          await client(command, "externalAction.get")["externalAction.get"]({
            params: { node_id: nodeId, attempt, action_key: actionKey },
            query: {},
            body: null,
          }),
          "externalAction.get",
        );
      },
    );
}
