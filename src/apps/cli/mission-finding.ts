import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  FINDING_IDENTITY_PREFIX,
  findingCreateSchema,
  findingDecideSchema,
  findingUpdateSchema,
  NODE_IDENTITY_PREFIX,
} from "../../mission/contract.ts";
import { parsePositiveInt, singleUse } from "./shared.ts";
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
const LIST_INVALID_NODE_ID = "cli.mission.finding.list.invalid_node_id";
const LIST_INVALID_ATTEMPT = "cli.mission.finding.list.invalid_attempt";
const LIST_INVALID_ROUND = "cli.mission.finding.list.invalid_round";
const GET_INVALID_FINDING_ID = "cli.mission.finding.get.invalid_finding_id";
const UNDECIDED_INVALID_PROJECT_ID =
  "cli.mission.finding.undecided.list.invalid_project_id";
const DECIDE_INVALID_FINDING_ID =
  "cli.mission.finding.decide.invalid_finding_id";
const CREATE_INVALID_NODE_ID = "cli.mission.finding.create.invalid_node_id";
const UPDATE_INVALID_FINDING_ID =
  "cli.mission.finding.update.invalid_finding_id";

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

function requireIdentity(prefix: string, value: string, code: string): void {
  if (!identitySchema(prefix).safeParse(value).success)
    throw new Diagnostic(code, `invalid ${prefix} ID`);
}

export function addFindingCommands(mission: Command): void {
  const finding = mission
    .command("finding")
    .description("Mission review findings");
  finding.action(() => finding.help());
  addPagination(
    finding
      .command("list")
      .description("List the review findings of a node as JSON")
      .argument("<node-id>", "Node ID")
      .option("--attempt <attempt>", "Attempt filter", singleUse("--attempt"))
      .option("--round <round>", "Round filter", singleUse("--round")),
  ).action(async (nodeId: string, _options, command: Command) => {
    requireIdentity(NODE_IDENTITY_PREFIX, nodeId, LIST_INVALID_NODE_ID);
    const options = command.optsWithGlobals();
    const attempt = attemptFilter(options.attempt);
    const round =
      options.round === undefined
        ? undefined
        : parsePositiveInt(options.round, LIST_INVALID_ROUND);
    printResult(
      await client(command, "finding.list")["finding.list"]({
        params: { node_id: nodeId },
        query: {
          ...pagination(options),
          ...(attempt === undefined ? {} : { attempt }),
          ...(round === undefined ? {} : { round }),
        },
        body: null,
      }),
      "finding.list",
    );
  });
  finding
    .command("get")
    .description("Get a review finding as JSON")
    .argument("<finding-id>", "Finding ID")
    .action(async (findingId: string, _options, command: Command) => {
      requireIdentity(
        FINDING_IDENTITY_PREFIX,
        findingId,
        GET_INVALID_FINDING_ID,
      );
      printResult(
        await client(command, "finding.get")["finding.get"]({
          params: { finding_id: findingId },
          query: {},
          body: null,
        }),
        "finding.get",
      );
    });
  const undecided = finding
    .command("undecided")
    .description("Review findings that wait for a human");
  undecided.action(() => undecided.help());
  addPagination(
    undecided
      .command("list")
      .description(
        "List the review findings of a project that wait for a human as JSON",
      )
      .argument("<project-id>", "Project ID"),
  ).action(async (projectId: string, _options, command: Command) => {
    requireIdentity("project", projectId, UNDECIDED_INVALID_PROJECT_ID);
    printResult(
      await client(command, "finding.undecided.list")["finding.undecided.list"](
        {
          params: { project_id: projectId },
          query: pagination(command.optsWithGlobals()),
          body: null,
        },
      ),
      "finding.undecided.list",
    );
  });
  addMutationOptions(
    finding
      .command("decide")
      .description("Decide a review finding that waits for a human")
      .argument("<finding-id>", "Finding ID"),
    { schema: findingDecideSchema, example: missionExamples.findingDecide },
  ).action(async (findingId: string, _options, command: Command) => {
    requireIdentity(
      FINDING_IDENTITY_PREFIX,
      findingId,
      DECIDE_INVALID_FINDING_ID,
    );
    await mutate(
      command,
      "finding.decide",
      findingDecideSchema,
      (api, body, key) =>
        api["finding.decide"](
          { params: { finding_id: findingId }, query: {}, body },
          { idempotencyKey: key },
        ),
    );
  });
  addMutationOptions(
    finding
      .command("create")
      .description("Create a human finding for a defect found after delivery")
      .argument("<node-id>", "Node ID"),
    { schema: findingCreateSchema, example: missionExamples.findingCreate },
  ).action(async (nodeId: string, _options, command: Command) => {
    requireIdentity(NODE_IDENTITY_PREFIX, nodeId, CREATE_INVALID_NODE_ID);
    await mutate(
      command,
      "finding.create",
      findingCreateSchema,
      (api, body, key) =>
        api["finding.create"](
          { params: { node_id: nodeId }, query: {}, body },
          { idempotencyKey: key },
        ),
    );
  });
  addMutationOptions(
    finding
      .command("update")
      .description("Update a human finding that holds no decision")
      .argument("<finding-id>", "Finding ID"),
    { schema: findingUpdateSchema, example: missionExamples.findingUpdate },
  ).action(async (findingId: string, _options, command: Command) => {
    requireIdentity(
      FINDING_IDENTITY_PREFIX,
      findingId,
      UPDATE_INVALID_FINDING_ID,
    );
    await mutate(
      command,
      "finding.update",
      findingUpdateSchema,
      (api, body, key) =>
        api["finding.update"](
          { params: { finding_id: findingId }, query: {}, body },
          { idempotencyKey: key },
        ),
    );
  });
}
