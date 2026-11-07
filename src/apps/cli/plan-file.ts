import { basename } from "node:path";
import type { Command } from "commander";
import { httpClient } from "../../gateway/client.ts";
import { Diagnostic, OperationError } from "../../kernel/errors.ts";
import {
  missionOperations,
  type Node,
  type NodeUpdate,
  startPointSchema,
  type TaskWrite,
  type Unblock,
  type UnblockChange,
} from "../../mission/contract.ts";
import {
  type ParsedNodeFile,
  type ParsedTaskFile,
  parsePlanFile,
} from "../../mission/parser.ts";
import {
  BindingState,
  LIST_LIMIT_MAX,
  projectOperations,
} from "../../project/contract.ts";
import { validateProjectId } from "./project.ts";
import { handleReadResult, readTextFile, singleUse } from "./shared.ts";

const PLAN_FILE_OPTION = "--plan-file";
const FILE_OPTION = "--file";
const MISSING_FILE_OPTION = "commander.missingMandatoryOptionValue";
const PLAN_FILE_CONFLICT = "cli.mission.node.plan_file_conflict";
const PLAN_FILE_INVALID = "cli.mission.node.plan_file_invalid";
const REASON_REQUIRED = "cli.mission.node.reason_required";
const PROJECT_REQUIRED = "cli.mission.node.project_required";
const PROJECT_INVALID = "cli.mission.node.invalid_project_id";
const PROJECT_MISMATCH = "cli.mission.node.project_mismatch";
const START_POINT_INVALID = "cli.mission.node.unblock.invalid_start_point";
const BINDING_PAGE_LIMIT = 100;
const NO_FILES = 0;
const NODE_FILE_INDEX = 0;
const TASK_FILES_START = 1;

export interface Connection {
  endpoint: string;
  token: string;
}

interface PlanFiles {
  node: ParsedNodeFile;
  tasks: ParsedTaskFile[];
}

interface PlanRead {
  node: Node;
  missionVersion: number;
  change: UnblockChange;
  filename: string;
}

function refuse(filename: string, reason: string): never {
  throw new Diagnostic(PLAN_FILE_INVALID, `Plan file ${filename}: ${reason}.`, {
    fields: [["file", filename]],
  });
}

export function addPlanFileOptions(command: Command): Command {
  return command
    .option(
      `${PLAN_FILE_OPTION} <path>`,
      "Plan file; the first is the node file, each later one a task file of that node",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--project <project-id>",
      "Project ID; required with --plan-file",
      singleUse("--project"),
    )
    .option(
      "--reason <text>",
      "Reason of the change; required with --plan-file",
      singleUse("--reason"),
    );
}

export function planFilePathsOf(command: Command): string[] | undefined {
  const options = command.optsWithGlobals();
  const paths: string[] = options.planFile ?? [];
  if (paths.length === NO_FILES) {
    if (options.file === undefined)
      command.error(`required option '${FILE_OPTION} <path>' not specified`, {
        code: MISSING_FILE_OPTION,
      });
    return undefined;
  }
  if (options.file !== undefined)
    throw new Diagnostic(
      PLAN_FILE_CONFLICT,
      `${PLAN_FILE_OPTION} and ${FILE_OPTION} are exclusive`,
    );
  if (options.reason === undefined)
    throw new Diagnostic(
      REASON_REQUIRED,
      `--reason is required with ${PLAN_FILE_OPTION}`,
    );
  if (options.project === undefined)
    throw new Diagnostic(
      PROJECT_REQUIRED,
      `--project is required with ${PLAN_FILE_OPTION}`,
    );
  validateProjectId(options.project, PROJECT_INVALID);
  return paths;
}

function parsed(path: string) {
  const filename = basename(path);
  const text = readTextFile(path);
  try {
    return parsePlanFile(filename, text);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    throw new Diagnostic(PLAN_FILE_INVALID, error.message, {
      fields: [["file", filename]],
      cause: error,
    });
  }
}

function planFilesOf(paths: string[]): PlanFiles {
  const node = parsed(paths[NODE_FILE_INDEX]!);
  if ("node" in node)
    refuse(node.filename, "the first file is not a node file");
  const tasks = paths.slice(TASK_FILES_START).map((path) => {
    const task = parsed(path);
    if (!("node" in task))
      refuse(task.filename, "a later file is not a task file");
    if (task.node !== node.filename)
      refuse(task.filename, `the task file names node ${task.node}`);
    return task;
  });
  return { node, tasks };
}

async function bindingIdsOf(
  connection: Connection,
  projectId: string,
): Promise<Map<string, string>> {
  const api = httpClient(
    projectOperations,
    connection.endpoint,
    connection.token,
  );
  const ids = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < BINDING_PAGE_LIMIT; page += 1) {
    const result = handleReadResult(
      await api["binding.list"]({
        params: { project_id: projectId },
        query: {
          state: BindingState.Current,
          limit: LIST_LIMIT_MAX,
          ...(cursor === undefined ? {} : { cursor }),
        },
        body: null,
      }),
      "cli.project.binding.list.indeterminate",
    );
    for (const binding of result.items) ids.set(binding.name, binding.id);
    if (result.next_cursor === null) return ids;
    cursor = result.next_cursor;
  }
  throw new Diagnostic(
    "cli.project.binding.list.too_many_pages",
    "the binding list exceeds the page limit",
  );
}

function resolved(
  filename: string,
  names: string[],
  ids: Map<string, string>,
): string[] {
  return names.map(
    (name) =>
      ids.get(name) ??
      refuse(filename, `binding ${name} is not in the project`),
  );
}

function taskWrites(
  files: PlanFiles,
  node: Node,
  ids: Map<string, string>,
): TaskWrite[] {
  const current = new Map(node.tasks.map((task) => [task.filename, task.id]));
  return files.tasks.map((task) => {
    const id = current.get(task.filename);
    return {
      ...(id === undefined ? {} : { id }),
      filename: task.filename,
      content: {
        name: task.name,
        requirement: task.requirement,
        criterion: task.criterion,
        verifications: task.verifications,
        bindings: resolved(task.filename, task.bindings, ids),
      },
    };
  });
}

function changeOf(
  files: PlanFiles,
  node: Node,
  ids: Map<string, string>,
  reason: string,
): UnblockChange {
  const { node: file } = files;
  return {
    content: {
      name: file.name,
      requirement: file.requirement,
      criterion: file.criterion,
      verifications: file.verifications,
      bindings: resolved(file.filename, file.bindings, ids),
      intent: file.intent,
      tags: file.tags,
      external_links: file.external_links,
      ...(file.commit_type === undefined
        ? {}
        : { commit_type: file.commit_type }),
    },
    tasks: taskWrites(files, node, ids),
    reason,
  };
}

async function planRead(
  command: Command,
  nodeId: string,
  paths: string[],
  connection: Connection,
): Promise<PlanRead> {
  const options = command.optsWithGlobals();
  const files = planFilesOf(paths);
  const api = httpClient(
    missionOperations,
    connection.endpoint,
    connection.token,
  );
  const node = handleReadResult(
    await api["node.get"]({
      params: { node_id: nodeId },
      query: {},
      body: null,
    }),
    "cli.mission.node.get.indeterminate",
  );
  const mission = handleReadResult(
    await api["get"]({
      params: { project_id: options.project },
      query: {},
      body: null,
    }),
    "cli.mission.get.indeterminate",
  );
  if (mission.id !== node.mission_id)
    throw new Diagnostic(
      PROJECT_MISMATCH,
      "the node belongs to a mission of another project",
    );
  const ids = await bindingIdsOf(connection, options.project);
  return {
    node,
    missionVersion: mission.version,
    change: changeOf(files, node, ids, options.reason),
    filename: files.node.filename,
  };
}

export async function nodeUpdateBody(
  command: Command,
  nodeId: string,
  paths: string[],
  connection: Connection,
): Promise<NodeUpdate> {
  const { node, missionVersion, change, filename } = await planRead(
    command,
    nodeId,
    paths,
    connection,
  );
  return {
    expected_revision: node.visible_revision,
    expected_mission_version: missionVersion,
    filename,
    content: change.content,
    tasks: change.tasks,
    reason: change.reason,
  };
}

export async function unblockBody(
  command: Command,
  nodeId: string,
  paths: string[],
  connection: Connection,
): Promise<Unblock> {
  const startPoint: string | undefined = command.optsWithGlobals().startPoint;
  const start = startPointSchema.safeParse(startPoint);
  if (startPoint !== undefined && !start.success)
    throw new Diagnostic(START_POINT_INVALID, "invalid start point");
  const { node, missionVersion, change } = await planRead(
    command,
    nodeId,
    paths,
    connection,
  );
  return {
    blocked_attempt: node.attempt,
    expected_revision: node.visible_revision,
    expected_mission_version: missionVersion,
    change,
    ...(start.success ? { start_point: start.data } : {}),
  };
}
