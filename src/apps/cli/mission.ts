import assert from "node:assert/strict";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { ensureDirectory, writePrivate } from "../../kernel/files.ts";
import { identitySchema } from "../../kernel/identity.ts";
import type { OperationResult } from "../../kernel/operation.ts";
import {
  criterionSetSchema,
  edgeKindSchema,
  graphEditSchema,
  ImportFormat,
  importFormatSchema,
  MISSION_IDENTITY_PREFIX,
  missionOperations,
  moveSchema,
  NODE_IDENTITY_PREFIX,
  nodeCreateSchema,
  nodeUpdateSchema,
  prioritySetSchema,
  rebindSchema,
  NODE_LIST_LIMIT_DEFAULT,
  NODE_LIST_LIMIT_MAX,
  NodeKind,
  nodeKindSchema,
  nodeStateSchema,
} from "../../mission/contract.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { validateProjectId } from "./project.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const CREATE = "create";
const UPDATE = "update";
const MOVE = "move";
const ADD = "add";
const REMOVE = "remove";
const SET = "set";
const DEPENDENCY = "dependency";
const CRITERION = "criterion";
const REBIND = "rebind";
const PRIORITY = "priority";
const BINDING_IDENTITY_PREFIX = "binding";
const REBIND_FILE_SCHEMA = rebindSchema.omit({ bindingId: true, nodeId: true });
const FILE_OPTION = "--file";
const KEY_OPTION = "--idempotency-key";
const GET = "get";
const LIST = "list";
const NODE = "node";
const EDGE = "edge";
const REVISION = "revision";
const RETIRE = "retire";
const PREVIEW = "preview";
const EXPORT = "export";
const NODE_LIST = "node.list";
const NODE_GET = "node.get";
const REVISION_LIST = "node.revision.list";
const REVISION_GET = "node.revision.get";
const EDGE_LIST = "edge.list";
const RETIRE_PREVIEW = "node.retire.preview";
const TRUE = "true";
const FALSE = "false";
const EMPTY = 0;
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const GET_INVALID_PROJECT_ID = "cli.mission.get.invalid_project_id";
const NODE_LIST_INVALID_MISSION_ID = "cli.mission.node.list.invalid_mission_id";
const NODE_LIST_INVALID_NODE_ID = "cli.mission.node.list.invalid_node_id";
const NODE_LIST_INVALID_KIND = "cli.mission.node.list.invalid_kind";
const NODE_LIST_INVALID_STATE = "cli.mission.node.list.invalid_state";
const KIND_STATE_CONFLICT = "cli.mission.node.list.kind_state_conflict";
const NODE_GET_INVALID_NODE_ID = "cli.mission.node.get.invalid_node_id";
const NODE_CREATE_INVALID_MISSION_ID =
  "cli.mission.node.create.invalid_mission_id";
const NODE_UPDATE_INVALID_NODE_ID = "cli.mission.node.update.invalid_node_id";
const NODE_MOVE_INVALID_NODE_ID = "cli.mission.node.move.invalid_node_id";
const REVISION_LIST_INVALID_NODE_ID =
  "cli.mission.node.revision.list.invalid_node_id";
const REVISION_GET_INVALID_NODE_ID =
  "cli.mission.node.revision.get.invalid_node_id";
const REVISION_GET_INVALID_REVISION =
  "cli.mission.node.revision.get.invalid_revision";
const EDGE_LIST_INVALID_MISSION_ID = "cli.mission.edge.list.invalid_mission_id";
const EDGE_LIST_INVALID_NODE_ID = "cli.mission.edge.list.invalid_node_id";
const EDGE_LIST_INVALID_KIND = "cli.mission.edge.list.invalid_kind";
const RETIRE_PREVIEW_INVALID_NODE_ID =
  "cli.mission.node.retire.preview.invalid_node_id";
const EXPORT_INVALID_MISSION_ID = "cli.mission.export.invalid_mission_id";
const EXPORT_INVALID_FORMAT = "cli.mission.export.invalid_format";
const EXPORT_OUT_NOT_EMPTY = "cli.mission.export.out_not_empty";
const DEPENDENCY_ADD_INVALID_NODE_ID =
  "cli.mission.dependency.add.invalid_node_id";
const DEPENDENCY_ADD_INVALID_DEPENDS_ON_ID =
  "cli.mission.dependency.add.invalid_depends_on_id";
const DEPENDENCY_REMOVE_INVALID_NODE_ID =
  "cli.mission.dependency.remove.invalid_node_id";
const DEPENDENCY_REMOVE_INVALID_DEPENDS_ON_ID =
  "cli.mission.dependency.remove.invalid_depends_on_id";
const CRITERION_SET_INVALID_NODE_ID =
  "cli.mission.criterion.set.invalid_node_id";
const REBIND_INVALID_MISSION_ID = "cli.mission.node.rebind.invalid_mission_id";
const REBIND_INVALID_BINDING_ID = "cli.mission.node.rebind.invalid_binding_id";
const REBIND_INVALID_NODE_ID = "cli.mission.node.rebind.invalid_node_id";
const PRIORITY_SET_INVALID_NODE_ID =
  "cli.mission.node.priority.set.invalid_node_id";

type ReadCommand =
  | typeof GET
  | typeof NODE_LIST
  | typeof NODE_GET
  | typeof REVISION_LIST
  | typeof REVISION_GET
  | typeof EDGE_LIST
  | typeof RETIRE_PREVIEW
  | typeof EXPORT;

export function validateMissionId(id: string, code: string): void {
  if (!identitySchema(MISSION_IDENTITY_PREFIX).safeParse(id).success)
    throw new Diagnostic(code, "invalid mission ID");
}

export function validateNodeId(id: string, code: string): void {
  if (!identitySchema(NODE_IDENTITY_PREFIX).safeParse(id).success)
    throw new Diagnostic(code, "invalid node ID");
}

function client(command: Command, name: ReadCommand) {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, `cli.mission.${name}.token_required`);
  return httpClient(missionOperations, endpoint, token);
}

function printResult<T>(result: OperationResult<T>, name: ReadCommand): void {
  const data = handleReadResult(result, `cli.mission.${name}.indeterminate`);
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function pagination(options: { limit?: string; cursor?: string }) {
  const limit =
    options.limit === undefined
      ? NODE_LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > NODE_LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${NODE_LIST_LIMIT_MAX}`,
    );
  return {
    limit,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
}

async function get(projectId: string, command: Command): Promise<void> {
  validateProjectId(projectId, GET_INVALID_PROJECT_ID);
  const result = await client(command, GET)[GET]({
    params: { projectId },
    query: {},
    body: null,
  });
  printResult(result, GET);
}

async function nodeList(missionId: string, command: Command): Promise<void> {
  validateMissionId(missionId, NODE_LIST_INVALID_MISSION_ID);
  const options = command.optsWithGlobals();
  const kind = nodeKindSchema.optional().safeParse(options.kind);
  if (!kind.success)
    throw new Diagnostic(NODE_LIST_INVALID_KIND, "invalid node kind");
  const state = nodeStateSchema.optional().safeParse(options.state);
  if (!state.success)
    throw new Diagnostic(NODE_LIST_INVALID_STATE, "invalid node state");
  if (kind.data === NodeKind.Task && state.data !== undefined)
    throw new Diagnostic(
      KIND_STATE_CONFLICT,
      "tasks have no independent state",
    );
  if (options.parent !== undefined)
    validateNodeId(options.parent, NODE_LIST_INVALID_NODE_ID);
  const query = {
    ...pagination(options),
    ...(kind.data !== undefined ? { kind: kind.data } : {}),
    ...(state.data !== undefined ? { state: state.data } : {}),
    ...(options.parent !== undefined ? { parentId: options.parent } : {}),
    includeRetired: options.includeRetired ? TRUE : FALSE,
  } as const;
  const result = await client(command, NODE_LIST)[NODE_LIST]({
    params: { missionId },
    query,
    body: null,
  });
  printResult(result, NODE_LIST);
}

async function nodeGet(nodeId: string, command: Command): Promise<void> {
  validateNodeId(nodeId, NODE_GET_INVALID_NODE_ID);
  const result = await client(command, NODE_GET)[NODE_GET]({
    params: { nodeId },
    query: {},
    body: null,
  });
  printResult(result, NODE_GET);
}

async function mutate<S extends z.ZodTypeAny, T extends object>(
  command: Command,
  name: string,
  schema: S,
  invoke: (
    api: ReturnType<typeof httpClient<typeof missionOperations>>,
    body: z.infer<S>,
    key: string,
  ) => Promise<OperationResult<T>>,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, `cli.mission.${name}.token_required`);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, schema);
  const result = await invoke(
    httpClient(missionOperations, endpoint, token),
    body,
    key,
  );
  const data = handleMutationResult(
    result,
    `cli.mission.${name}.indeterminate`,
    key,
  );
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function nodeCreate(missionId: string, command: Command): Promise<void> {
  validateMissionId(missionId, NODE_CREATE_INVALID_MISSION_ID);
  await mutate(command, "node.create", nodeCreateSchema, (api, body, key) =>
    api["node.create"](
      { params: { missionId }, query: {}, body },
      { idempotencyKey: key },
    ),
  );
}

async function nodeUpdate(nodeId: string, command: Command): Promise<void> {
  validateNodeId(nodeId, NODE_UPDATE_INVALID_NODE_ID);
  await mutate(command, "node.update", nodeUpdateSchema, (api, body, key) =>
    api["node.update"](
      { params: { nodeId }, query: {}, body },
      { idempotencyKey: key },
    ),
  );
}

async function nodeMove(nodeId: string, command: Command): Promise<void> {
  validateNodeId(nodeId, NODE_MOVE_INVALID_NODE_ID);
  await mutate(command, "node.move", moveSchema, (api, body, key) =>
    api["node.move"](
      { params: { nodeId }, query: {}, body },
      { idempotencyKey: key },
    ),
  );
}

async function dependencyEdit(
  nodeId: string,
  dependsOnId: string,
  command: Command,
  action: typeof ADD | typeof REMOVE,
): Promise<void> {
  const name = `dependency.${action}` as const;
  validateNodeId(
    nodeId,
    action === ADD
      ? DEPENDENCY_ADD_INVALID_NODE_ID
      : DEPENDENCY_REMOVE_INVALID_NODE_ID,
  );
  validateNodeId(
    dependsOnId,
    action === ADD
      ? DEPENDENCY_ADD_INVALID_DEPENDS_ON_ID
      : DEPENDENCY_REMOVE_INVALID_DEPENDS_ON_ID,
  );
  await mutate(command, name, graphEditSchema, (api, body, key) =>
    api[name](
      { params: { nodeId, dependsOnId }, query: {}, body },
      { idempotencyKey: key },
    ),
  );
}

async function criterionSet(nodeId: string, command: Command): Promise<void> {
  validateNodeId(nodeId, CRITERION_SET_INVALID_NODE_ID);
  await mutate(command, "criterion.set", criterionSetSchema, (api, body, key) =>
    api["criterion.set"](
      { params: { nodeId }, query: {}, body },
      { idempotencyKey: key },
    ),
  );
}

async function nodeRebind(
  missionId: string,
  bindingId: string,
  command: Command,
): Promise<void> {
  validateMissionId(missionId, REBIND_INVALID_MISSION_ID);
  if (!identitySchema(BINDING_IDENTITY_PREFIX).safeParse(bindingId).success)
    throw new Diagnostic(REBIND_INVALID_BINDING_ID, "invalid binding ID");
  const nodeId = command.optsWithGlobals().node as string | undefined;
  if (nodeId !== undefined) validateNodeId(nodeId, REBIND_INVALID_NODE_ID);
  await mutate(command, "node.rebind", REBIND_FILE_SCHEMA, (api, file, key) =>
    api["node.rebind"](
      {
        params: { missionId },
        query: {},
        body: {
          ...file,
          bindingId,
          ...(nodeId === undefined ? {} : { nodeId }),
        },
      },
      { idempotencyKey: key },
    ),
  );
}

async function prioritySet(nodeId: string, command: Command): Promise<void> {
  validateNodeId(nodeId, PRIORITY_SET_INVALID_NODE_ID);
  await mutate(
    command,
    "node.priority.set",
    prioritySetSchema,
    (api, body, key) =>
      api["node.priority.set"](
        { params: { nodeId }, query: {}, body },
        { idempotencyKey: key },
      ),
  );
}

async function revisionList(nodeId: string, command: Command): Promise<void> {
  validateNodeId(nodeId, REVISION_LIST_INVALID_NODE_ID);
  const query = pagination(command.optsWithGlobals());
  const result = await client(command, REVISION_LIST)[REVISION_LIST]({
    params: { nodeId },
    query,
    body: null,
  });
  printResult(result, REVISION_LIST);
}

async function revisionGet(
  nodeId: string,
  revision: string,
  command: Command,
): Promise<void> {
  validateNodeId(nodeId, REVISION_GET_INVALID_NODE_ID);
  const rev = parsePositiveInt(revision, REVISION_GET_INVALID_REVISION);
  const result = await client(command, REVISION_GET)[REVISION_GET]({
    params: { nodeId, revision: rev },
    query: {},
    body: null,
  });
  printResult(result, REVISION_GET);
}

async function edgeList(missionId: string, command: Command): Promise<void> {
  validateMissionId(missionId, EDGE_LIST_INVALID_MISSION_ID);
  const options = command.optsWithGlobals();
  const kind = edgeKindSchema.optional().safeParse(options.kind);
  if (!kind.success)
    throw new Diagnostic(EDGE_LIST_INVALID_KIND, "invalid edge kind");
  if (options.node !== undefined)
    validateNodeId(options.node, EDGE_LIST_INVALID_NODE_ID);
  const query = {
    ...pagination(options),
    ...(kind.data !== undefined ? { kind: kind.data } : {}),
    ...(options.node !== undefined ? { nodeId: options.node } : {}),
  };
  const result = await client(command, EDGE_LIST)[EDGE_LIST]({
    params: { missionId },
    query,
    body: null,
  });
  printResult(result, EDGE_LIST);
}

async function retirePreview(nodeId: string, command: Command): Promise<void> {
  validateNodeId(nodeId, RETIRE_PREVIEW_INVALID_NODE_ID);
  const options = command.optsWithGlobals();
  const result = await client(command, RETIRE_PREVIEW)[RETIRE_PREVIEW]({
    params: { nodeId },
    query: { force: options.force ? TRUE : FALSE },
    body: null,
  });
  printResult(result, RETIRE_PREVIEW);
}

function validateExportDirectory(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || readdirSync(path).length !== EMPTY))
    throw new Diagnostic(
      EXPORT_OUT_NOT_EMPTY,
      "output must be an absent or empty directory",
    );
}

async function exportMission(
  missionId: string,
  command: Command,
): Promise<void> {
  validateMissionId(missionId, EXPORT_INVALID_MISSION_ID);
  const options = command.optsWithGlobals();
  const format = importFormatSchema.safeParse(options.format);
  if (!format.success)
    throw new Diagnostic(EXPORT_INVALID_FORMAT, "invalid export format");
  if (format.data === ImportFormat.Markdown)
    validateExportDirectory(options.out);
  const result = await client(command, EXPORT)[EXPORT]({
    params: { missionId },
    query: { format: format.data },
    body: null,
  });
  const data = handleReadResult(result, `cli.mission.${EXPORT}.indeterminate`);
  assert.equal(data.missionId, missionId);
  if (format.data === ImportFormat.Markdown) {
    assert.ok("files" in data);
    validateExportDirectory(options.out);
    ensureDirectory(options.out);
    for (const entry of data.files)
      writePrivate(join(options.out, entry.filename), entry.content);
  } else {
    assert.ok("entries" in data);
    writePrivate(options.out, JSON.stringify(data));
  }
  process.stdout.write(
    `${JSON.stringify({ missionId: data.missionId, missionVersion: data.missionVersion })}\n`,
  );
}

function addPagination(command: Command): Command {
  return command
    .option(
      "--limit <count>",
      "Maximum results per page (default: 100, range: 1..1000)",
      singleUse("--limit"),
    )
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    );
}

export function addMissionCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Mission),
  );
  const mission = program
    .command(CommandName.Mission)
    .description("Mission Service commands")
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "Human JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  mission.action(() => mission.help());
  mission
    .command(GET)
    .description("Get a project's mission as JSON")
    .argument("<project-id>", "Project ID")
    .action((projectId: string, _options, command: Command) =>
      get(projectId, command),
    );
  mission
    .command(EXPORT)
    .description("Export the current mission plan")
    .argument("<mission-id>", "Mission ID")
    .requiredOption(
      "--format <markdown|json>",
      "Export format",
      singleUse("--format"),
    )
    .requiredOption(
      "--out <path>",
      "Empty directory for Markdown, file for JSON",
      singleUse("--out"),
    )
    .action((missionId: string, _options, command: Command) =>
      exportMission(missionId, command),
    );
  addNodeCommands(mission);
  addEdgeCommands(mission);
  addDependencyCommands(mission);
  addCriterionCommands(mission);
}

function addMutationOptions(command: Command): Command {
  return command
    .requiredOption(
      FILE_OPTION + " <path>",
      "Node JSON file",
      singleUse(FILE_OPTION),
    )
    .option(KEY_OPTION + " <key>", "Mutation key", singleUse(KEY_OPTION));
}

function addNodeCommands(mission: Command): void {
  const node = mission.command(NODE).description("Mission node commands");
  node.action(() => node.help());
  addPagination(
    node
      .command(LIST)
      .description("List mission nodes as JSON")
      .argument("<mission-id>", "Mission ID")
      .option(
        "--kind <kind>",
        "Filter by initiative, objective, or task",
        singleUse("--kind"),
      )
      .option(
        "--state <state>",
        "Filter by exact node state (not tasks)",
        singleUse("--state"),
      )
      .option(
        "--parent <node-id>",
        "Filter direct children",
        singleUse("--parent"),
      )
      .option("--include-retired", "Include retired nodes", false),
  ).action((missionId: string, _options, command: Command) =>
    nodeList(missionId, command),
  );
  node
    .command(GET)
    .description("Get a mission node as JSON")
    .argument("<node-id>", "Node ID")
    .action((nodeId: string, _options, command: Command) =>
      nodeGet(nodeId, command),
    );
  addMutationOptions(
    node
      .command(CREATE)
      .description("Create a mission node as JSON")
      .argument("<mission-id>", "Mission ID"),
  ).action((missionId: string, _options, command: Command) =>
    nodeCreate(missionId, command),
  );
  addMutationOptions(
    node
      .command(UPDATE)
      .description("Update a mission node as JSON")
      .argument("<node-id>", "Node ID"),
  ).action((nodeId: string, _options, command: Command) =>
    nodeUpdate(nodeId, command),
  );
  addMutationOptions(
    node
      .command(MOVE)
      .description("Move a mission node as JSON")
      .argument("<node-id>", "Node ID"),
  ).action((nodeId: string, _options, command: Command) =>
    nodeMove(nodeId, command),
  );
  const retire = node
    .command(RETIRE)
    .description("Mission node retirement commands");
  retire.action(() => retire.help());
  retire
    .command(PREVIEW)
    .description("Preview node retirement as JSON")
    .argument("<node-id>", "Node ID")
    .option("--force", "Remove dependencies of nonterminal dependents", false)
    .action((nodeId: string, _options, command: Command) =>
      retirePreview(nodeId, command),
    );
  addRevisionCommands(node);
  addNodeRebind(node);
  addNodePriority(node);
}

function addNodeRebind(node: Command): void {
  addMutationOptions(
    node
      .command(REBIND)
      .description("Rebind mission nodes")
      .argument("<mission-id>", "Mission ID")
      .argument("<binding-id>", "Binding ID")
      .option("--node <node-id>", "Rebind only this node", singleUse("--node")),
  ).action((missionId: string, bindingId: string, _options, command: Command) =>
    nodeRebind(missionId, bindingId, command),
  );
}

function addNodePriority(node: Command): void {
  const priority = node
    .command(PRIORITY)
    .description("Mission node priority commands");
  priority.action(() => priority.help());
  addMutationOptions(
    priority
      .command(SET)
      .description("Set node priority")
      .argument("<node-id>", "Node ID"),
  ).action((nodeId: string, _options, command: Command) =>
    prioritySet(nodeId, command),
  );
}

function addRevisionCommands(node: Command): void {
  const revision = node.command(REVISION).description("Mission node revisions");
  revision.action(() => revision.help());
  addPagination(
    revision
      .command(LIST)
      .description("List node revisions as JSON")
      .argument("<node-id>", "Node ID"),
  ).action((nodeId: string, _options, command: Command) =>
    revisionList(nodeId, command),
  );
  revision
    .command(GET)
    .description("Get a node revision as JSON")
    .argument("<node-id>", "Node ID")
    .argument("<revision>", "Positive safe integer revision")
    .action((nodeId: string, rev: string, _options, command: Command) =>
      revisionGet(nodeId, rev, command),
    );
}

function addDependencyCommands(mission: Command): void {
  const dependency = mission
    .command(DEPENDENCY)
    .description("Mission dependency commands");
  dependency.action(() => dependency.help());
  for (const action of [ADD, REMOVE] as const) {
    addMutationOptions(
      dependency
        .command(action)
        .description(`${action} a dependency`)
        .argument("<node-id>", "Dependent node ID")
        .argument("<depends-on-id>", "Prerequisite node ID"),
    ).action(
      (nodeId: string, dependsOnId: string, _options, command: Command) =>
        dependencyEdit(nodeId, dependsOnId, command, action),
    );
  }
}

function addCriterionCommands(mission: Command): void {
  const criterion = mission
    .command(CRITERION)
    .description("Mission criterion commands");
  criterion.action(() => criterion.help());
  addMutationOptions(
    criterion
      .command(SET)
      .description("Set node criterion")
      .argument("<node-id>", "Node ID"),
  ).action((nodeId: string, _options, command: Command) =>
    criterionSet(nodeId, command),
  );
}

function addEdgeCommands(mission: Command): void {
  const edge = mission.command(EDGE).description("Mission edge commands");
  edge.action(() => edge.help());
  addPagination(
    edge
      .command(LIST)
      .description("List mission edges as JSON")
      .argument("<mission-id>", "Mission ID")
      .option(
        "--kind <kind>",
        "Filter by containment or dependency",
        singleUse("--kind"),
      )
      .option("--node <node-id>", "Filter incident edges", singleUse("--node")),
  ).action((missionId: string, _options, command: Command) =>
    edgeList(missionId, command),
  );
}
