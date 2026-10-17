import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { z } from "zod";
import { ulid } from "ulid";
import { httpClient } from "../../gateway/client.ts";
import { writePrivate } from "../../kernel/files.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  ImportFormat,
  MISSION_INITIAL_VERSION,
  MissionErrorCode,
  NodeState,
  Work,
  type ControlResult,
  type Edge,
  type ImportPreview,
  type ImportResult,
  type Mission,
  type Node,
  type NodeChange,
} from "../../mission/contract.ts";
import { ProjectErrorCode, projectOperations } from "../../project/contract.ts";
import type { Job } from "../../scheduler/contract.ts";
import {
  cliSession,
  createCredentials,
  kanthord,
  repositoryBinding,
} from "./cli-support.ts";
import {
  COVERING_WORKER_BINDINGS,
  enableCoveringAgents,
  FAKE_SSH_IDENTITY,
  gatewayFixture,
} from "./test-support.ts";

const FAILURE = 1;
const NO_OUTPUT = "";
const UTF8 = "utf8";
const MASK = "e2e-todoapp-mask";
const REASON = "plan";
const REPOSITORY_BINDING = "todoapp-repo";
const MIRROR_BINDING = "todoapp-mirror";
const ACTION = "pull_request";
const PLAN_DIRECTORY = new URL("__fixtures__/todoapp/plan/", import.meta.url);
const PLAN_FILE_COUNT = 26;
const NODE_COUNT = 8;
const TASK_COUNT = 18;
const TASKS_PER_NODE = 3;
const NO_ATTEMPT = 0;
const NO_ITEMS = 0;
const INITIAL_REVISION = 1;
const SECOND_REVISION = 2;
const VERSION_INCREMENT = 1;
const SINGLE_ITEM = 1;
const RETIRED_EDGE_COUNT = 7;
const PREVIEW_DIGEST = /^[0-9a-f]{64}$/;
const TASK_IDENTITY = /^task_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_IDENTITY_PREFIX = "task_";
const TODO_API = "todo-api.md";
const FOUNDATION = "foundation.md";
const PERSISTENCE = "persistence.md";
const AUTHENTICATION = "authentication.md";
const TODOS = "todos.md";
const OPERATIONS = "operations.md";
const ACCEPTANCE = "acceptance.md";
const CONTRIBUTING = "contributing.md";
const TODOS_CRUD = "todos-crud.md";
const TODOS_ISOLATION = "todos-isolation.md";
const FOUNDATION_RUNTIME = "foundation-runtime.md";
const IMPLEMENT_FILES = [
  FOUNDATION,
  PERSISTENCE,
  AUTHENTICATION,
  TODOS,
  OPERATIONS,
  ACCEPTANCE,
  CONTRIBUTING,
];
const TASKLESS_FILES = [TODO_API, CONTRIBUTING];
const EDGES = [
  [PERSISTENCE, FOUNDATION],
  [AUTHENTICATION, PERSISTENCE],
  [TODOS, AUTHENTICATION],
  [OPERATIONS, FOUNDATION],
  [ACCEPTANCE, TODOS],
  [ACCEPTANCE, OPERATIONS],
  [CONTRIBUTING, FOUNDATION],
  ...IMPLEMENT_FILES.map((file) => [TODO_API, file]),
]
  .map(([dependent, dependsOn]) => `${dependent} -> ${dependsOn}`)
  .sort();
const OVERRIDE_ORDER = [
  FOUNDATION,
  PERSISTENCE,
  AUTHENTICATION,
  TODOS,
  OPERATIONS,
  CONTRIBUTING,
  ACCEPTANCE,
];
const QUEUE_AFTER_OVERRIDE = [
  [CONTRIBUTING, OPERATIONS, PERSISTENCE],
  [AUTHENTICATION, CONTRIBUTING, OPERATIONS],
  [CONTRIBUTING, OPERATIONS, TODOS],
  [CONTRIBUTING, OPERATIONS],
  [ACCEPTANCE, CONTRIBUTING],
  [ACCEPTANCE],
  [TODO_API],
];
const NEW_CRITERION = "- A new criterion item that the edit adds.";
const UPDATED_CRITERION = "A criterion that the human update writes.";
const TODOAPP_TIMEOUT_MS = 120000;

type Page<T> = { items: T[]; next_cursor: string | null };
type Applied = {
  binding_set_version: number;
  bindings: Record<string, { id: string }>;
};
type Project = {
  projectId: string;
  missionId: string;
  bindingId: string;
  workerBindingIds: string[];
};
type BindingSetBody = z.input<
  (typeof projectOperations)["bindingSet.write"]["input"]
>["body"];
type Violation = ImportPreview["violations"][number];
type Edit = (files: Record<string, string>) => void;
type Harness = Awaited<ReturnType<typeof setup>>;

function planContents(): Record<string, string> {
  const names = readdirSync(PLAN_DIRECTORY).sort();
  assert.equal(names.length, PLAN_FILE_COUNT);
  return Object.fromEntries(
    names.map((name) => [
      name,
      readFileSync(new URL(name, PLAN_DIRECTORY), UTF8),
    ]),
  );
}

function replaced(
  files: Record<string, string>,
  name: string,
  from: string,
  to: string,
): void {
  const content = files[name];
  assert.ok(
    content !== undefined && content.includes(from),
    `${name}: ${from}`,
  );
  files[name] = content.replace(from, to);
}

function bindingNames(names: string[]): string {
  return `bindings:\n${names.map((name) => `  - ${name}\n`).join("")}`;
}

function byFilename(items: Node[]): Record<string, Node> {
  return Object.fromEntries(items.map((item) => [item.filename, item]));
}

function edgeNames(items: Node[], list: Edge[]): string[] {
  const names = Object.fromEntries(
    items.map((item) => [item.id, item.filename]),
  );
  return list
    .map(
      (edge) => `${names[edge.dependent_id]} -> ${names[edge.depends_on_id]}`,
    )
    .sort();
}

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
  });
  const session = cliSession(t, fixture.endpoint, fixture.token, MASK);
  const { read, write } = session;
  await createCredentials(session, MASK);
  await enableCoveringAgents(session.H);
  let sequence = 0;
  const jsonFile = (body: unknown) => {
    const path = join(session.H.XDG_CONFIG_HOME!, `body-${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const refuses = async (args: string[], body: unknown, code: string) => {
    const result = await kanthord(
      [...args, "--file", jsonFile(body)],
      session.H,
    );
    assert.equal(result.code, FAILURE, result.stderr);
    assert.equal(result.stdout, NO_OUTPUT);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  };
  const planFiles = (edit?: Edit) => {
    const files = planContents();
    edit?.(files);
    const directory = join(temporary(t), "plan");
    mkdirSync(directory);
    return Object.entries(files).map(([name, content]) => {
      const path = join(directory, name);
      writePrivate(path, content);
      return path;
    });
  };
  const bindingSetVersion = async (project: Project) =>
    (
      await read<{ binding_set_version: number }>([
        "project",
        "get",
        project.projectId,
      ])
    ).binding_set_version;
  const todoappProject = async (): Promise<Project> => {
    const created = await read<{ id: string }>([
      "project",
      "create",
      "--name",
      `todoapp-${ulid().toLowerCase()}`,
    ]);
    const applied = await write<Applied>(
      ["project", "binding", "apply", created.id],
      {
        version: INITIAL_REVISION,
        bindings: {
          ...COVERING_WORKER_BINDINGS,
          [REPOSITORY_BINDING]: repositoryBinding(REPOSITORY_BINDING, ACTION),
        },
      },
    );
    const mission = await read<Mission>(["mission", "get", created.id]);
    assert.equal(mission.version, MISSION_INITIAL_VERSION);
    return {
      projectId: created.id,
      missionId: mission.id,
      bindingId: applied.bindings[REPOSITORY_BINDING]!.id,
      workerBindingIds: Object.keys(COVERING_WORKER_BINDINGS).map(
        (name) => applied.bindings[name]!.id,
      ),
    };
  };
  const missionVersion = async (project: Project) =>
    (await read<Mission>(["mission", "get", project.projectId])).version;
  const nodes = async (project: Project) =>
    (await read<Page<Node>>(["mission", "node", "list", project.missionId]))
      .items;
  const edges = async (project: Project) =>
    (await read<Page<Edge>>(["mission", "edge", "list", project.missionId]))
      .items;
  const node = (id: string) => read<Node>(["mission", "node", "get", id]);
  const controls = async (project: Project, version?: number) => ({
    format: ImportFormat.Markdown,
    mission_version: version ?? (await missionVersion(project)),
    reason: REASON,
  });
  const preview = async (project: Project, paths: string[], version?: number) =>
    write<ImportPreview>(
      ["mission", "import", "preview", project.missionId, ...paths],
      await controls(project, version),
    );
  const applyArgs = (project: Project, paths: string[]) => [
    "mission",
    "import",
    "apply",
    project.missionId,
    ...paths,
    "--idempotency-key",
    ulid(),
  ];
  const applyBody = async (
    project: Project,
    previewed: ImportPreview,
    confirmed: string[],
  ) => ({
    ...(await controls(project, previewed.expected_mission_version)),
    preview_digest: previewed.preview_digest,
    confirmed_retirements: confirmed,
  });
  const apply = async (
    project: Project,
    paths: string[],
    previewed: ImportPreview,
    confirmed: string[] = [],
  ) =>
    write<ImportResult>(
      applyArgs(project, paths),
      await applyBody(project, previewed, confirmed),
    );
  const importAll = async (project: Project, paths: string[]) => {
    const previewed = await preview(project, paths);
    assert.deepEqual(previewed.violations, []);
    return apply(project, paths, previewed, previewed.retirements);
  };
  const baseline = async () => {
    const project = await todoappProject();
    const result = await importAll(project, planFiles());
    return { project, result };
  };
  const refusedImport = async (
    project: Project,
    paths: string[],
    code: string,
    filename?: string,
  ): Promise<Violation[]> => {
    const versionBefore = await missionVersion(project);
    const nodesBefore = await nodes(project);
    const previewed = await preview(project, paths);
    const found = previewed.violations.filter((item) => item.code === code);
    assert.notEqual(
      found.length,
      NO_ITEMS,
      JSON.stringify(previewed.violations),
    );
    if (filename)
      assert.ok(
        found.some((item) => item.filename === filename),
        JSON.stringify(found),
      );
    await refuses(
      applyArgs(project, paths),
      await applyBody(project, previewed, []),
      code,
    );
    assert.equal(await missionVersion(project), versionBefore);
    assert.deepEqual(await nodes(project), nodesBefore);
    return found;
  };
  const exported = async (project: Project) => {
    const out = join(temporary(t), "export");
    const answer = await read<{ mission_version: number }>([
      "mission",
      "export",
      project.missionId,
      "--format",
      ImportFormat.Markdown,
      "--out",
      out,
    ]);
    return {
      version: answer.mission_version,
      paths: readdirSync(out)
        .sort()
        .map((name) => join(out, name)),
    };
  };
  const jobs = async (project: Project) =>
    (await read<Page<Job>>(["scheduler", "queue", "list", project.projectId]))
      .items;
  const control = async (
    action: string,
    nodeId: string,
    project: Project,
    extra: string[] = [],
  ) =>
    write<ControlResult>(["mission", "node", action, nodeId, ...extra], {
      reason: REASON,
      expected_mission_version: await missionVersion(project),
      expected_state: NodeState.Available,
      expected_attempt: NO_ATTEMPT,
    });
  const update = async (
    project: Project,
    found: Node,
    change: Partial<Node["content"]>,
  ) =>
    write<NodeChange>(["mission", "node", "update", found.id], {
      filename: found.filename,
      content: { ...found.content, ...change },
      tasks: found.tasks,
      reason: REASON,
      expected_revision: found.visible_revision,
      expected_mission_version: await missionVersion(project),
    });
  const overrideInOrder = async (
    project: Project,
    afterEach?: (step: number, queued: string[]) => void,
  ) => {
    const all = await nodes(project);
    const names = Object.fromEntries(
      all.map((item) => [item.id, item.filename]),
    );
    const ids = Object.fromEntries(all.map((item) => [item.filename, item.id]));
    for (const [step, name] of OVERRIDE_ORDER.entries()) {
      const answer = await control("override", ids[name]!, project, [
        "--result",
        "success",
      ]);
      assert.equal(answer.node.state, NodeState.Completed);
      afterEach?.(
        step,
        (await jobs(project)).map((job) => names[job.node_id]!).sort(),
      );
    }
    return { names, ids };
  };
  const failedBindingSet = async (
    project: Project,
    bindings: Record<string, unknown>,
  ) => {
    const result = (await httpClient(
      { operation: projectOperations["bindingSet.write"] },
      fixture.endpoint,
      fixture.token,
    ).operation({
      params: { project_id: project.projectId },
      query: {},
      body: {
        version: await bindingSetVersion(project),
        bindings: bindings as BindingSetBody["bindings"],
      },
    })) as OperationResult<unknown>;
    assert.equal(result.type, OperationResultType.Failure);
    if (result.type !== OperationResultType.Failure) throw new Error();
    return result.error.error;
  };
  return {
    read,
    write,
    refuses,
    planFiles,
    bindingSetVersion,
    todoappProject,
    missionVersion,
    nodes,
    edges,
    node,
    preview,
    apply,
    importAll,
    baseline,
    refusedImport,
    exported,
    jobs,
    update,
    control,
    overrideInOrder,
    failedBindingSet,
  };
}

function todoapp(title: string, run: (h: Harness) => Promise<void>) {
  test(title, { timeout: TODOAPP_TIMEOUT_MS }, async (t) => {
    await run(await setup(t));
  });
}

todoapp(
  "a fresh todoapp project holds an empty mission at version 1",
  async (h) => {
    const project = await h.todoappProject();
    assert.equal(await h.missionVersion(project), MISSION_INITIAL_VERSION);
    assert.deepEqual(await h.nodes(project), []);
    assert.deepEqual(await h.edges(project), []);
  },
);

todoapp(
  "EF06.1 the baseline preview holds no violation and writes no node",
  async (h) => {
    const project = await h.todoappProject();
    const previewed = await h.preview(project, h.planFiles());
    assert.deepEqual(previewed.violations, []);
    assert.deepEqual(previewed.retirements, []);
    assert.match(previewed.preview_digest, PREVIEW_DIGEST);
    assert.equal(previewed.creates.length, PLAN_FILE_COUNT);
    assert.deepEqual(await h.nodes(project), []);
    assert.equal(await h.missionVersion(project), MISSION_INITIAL_VERSION);
  },
);

todoapp(
  "EF06.2 the baseline apply writes eight nodes, eighteen tasks and fourteen edges atomically",
  async (h) => {
    const { project, result } = await h.baseline();
    assert.equal(
      result.mission_version,
      MISSION_INITIAL_VERSION + VERSION_INCREMENT,
    );
    assert.equal(
      await h.missionVersion(project),
      MISSION_INITIAL_VERSION + VERSION_INCREMENT,
    );
    const all = await h.nodes(project);
    assert.equal(all.length, NODE_COUNT);
    assert.deepEqual(
      all.filter((item) => item.work === Work.Examine).map((i) => i.filename),
      [TODO_API],
    );
    assert.equal(
      all.filter((item) => item.work === Work.Implement).length,
      NODE_COUNT - SINGLE_ITEM,
    );
    assert.equal(
      all.reduce((count, item) => count + item.tasks.length, 0),
      TASK_COUNT,
    );
    for (const item of all)
      assert.equal(
        item.tasks.length,
        TASKLESS_FILES.includes(item.filename) ? 0 : TASKS_PER_NODE,
        item.filename,
      );
    assert.deepEqual(edgeNames(all, await h.edges(project)), EDGES);
  },
);

todoapp(
  "EF06.3 every node pins the repository binding and no node pins a worker binding",
  async (h) => {
    const { project } = await h.baseline();
    for (const listed of await h.nodes(project)) {
      const found = await h.node(listed.id);
      assert.deepEqual(found.content.bindings, [project.bindingId]);
      for (const task of found.tasks)
        assert.deepEqual(task.content.bindings, []);
      for (const worker of project.workerBindingIds)
        assert.ok(!found.content.bindings.includes(worker));
    }
  },
);

todoapp(
  "EF06.4 every node starts at revision 1 and attempt 0 and every task is content",
  async (h) => {
    const { project } = await h.baseline();
    for (const listed of await h.nodes(project)) {
      const found = await h.node(listed.id);
      assert.equal(found.visible_revision, INITIAL_REVISION);
      assert.equal(found.attempt, NO_ATTEMPT);
      for (const task of found.tasks) {
        assert.match(task.id, TASK_IDENTITY);
        for (const field of ["revision", "state", "attempt"])
          assert.ok(!Object.hasOwn(task, field), field);
      }
    }
  },
);

todoapp("EF06.5 the export imports again with no change", async (h) => {
  const { project, result } = await h.baseline();
  const before = await h.nodes(project);
  const edgesBefore = await h.edges(project);
  const { version, paths } = await h.exported(project);
  assert.equal(version, result.mission_version);
  assert.equal(paths.length, PLAN_FILE_COUNT);
  const previewed = await h.preview(project, paths, version);
  assert.deepEqual(previewed.violations, []);
  assert.deepEqual(previewed.creates, []);
  assert.deepEqual(previewed.updates, []);
  assert.deepEqual(previewed.retirements, []);
  assert.equal(previewed.no_ops.length, NODE_COUNT);
  const applied = await h.apply(project, paths, previewed);
  assert.equal(applied.mission_version, version);
  assert.deepEqual(await h.nodes(project), before);
  assert.deepEqual(await h.edges(project), edgesBefore);
});

todoapp(
  "EF06.6 an unknown front matter field and an unknown H2 refuse the whole import",
  async (h) => {
    const project = await h.todoappProject();
    for (const edit of [
      (files: Record<string, string>) =>
        replaced(
          files,
          TODOS,
          "work: implement\n",
          "work: implement\nowner: x\n",
        ),
      (files: Record<string, string>) => {
        files[TODOS] += "\n## Notes\n\nAn unknown section.\n";
      },
    ])
      await h.refusedImport(
        project,
        h.planFiles(edit),
        MissionErrorCode.PlanInvalid,
        TODOS,
      );
  },
);

todoapp("EF06.7 a dependency on a missing file is refused", async (h) => {
  const project = await h.todoappProject();
  await h.refusedImport(
    project,
    h.planFiles((files) =>
      replaced(files, PERSISTENCE, "  - foundation.md", "  - missing.md"),
    ),
    MissionErrorCode.UnresolvedReference,
  );
});

todoapp("EF06.8 a repeated file name is refused", async (h) => {
  const project = await h.todoappProject();
  const [repeated] = h.planFiles().filter((path) => path.endsWith(TODOS));
  await h.refusedImport(
    project,
    [...h.planFiles(), repeated!],
    MissionErrorCode.DuplicateFile,
  );
});

todoapp(
  "EF06.9 a task file refuses depends_on, requires and work",
  async (h) => {
    const project = await h.todoappProject();
    for (const key of ["depends_on: []", "requires: []", "work: implement"])
      await h.refusedImport(
        project,
        h.planFiles((files) =>
          replaced(
            files,
            TODOS_CRUD,
            "node: todos.md\n",
            `node: todos.md\n${key}\n`,
          ),
        ),
        MissionErrorCode.PlanInvalid,
        TODOS_CRUD,
      );
  },
);

todoapp("EF06.10 a task file on an examine node is refused", async (h) => {
  const project = await h.todoappProject();
  await h.refusedImport(
    project,
    h.planFiles((files) =>
      replaced(files, TODOS_CRUD, "node: todos.md", `node: ${TODO_API}`),
    ),
    MissionErrorCode.ReferenceKindInvalid,
  );
});

todoapp(
  "EF06.11 an implement node with no repository binding takes none from the project",
  async (h) => {
    const project = await h.todoappProject();
    await h.refusedImport(
      project,
      h.planFiles((files) =>
        replaced(
          files,
          TODOS,
          bindingNames([REPOSITORY_BINDING]),
          "bindings: []\n",
        ),
      ),
      MissionErrorCode.BindingsInvalid,
    );
  },
);

todoapp(
  "EF06.12 a node verification that no task holds is refused",
  async (h) => {
    const project = await h.todoappProject();
    await h.refusedImport(
      project,
      h.planFiles((files) =>
        replaced(
          files,
          FOUNDATION_RUNTIME,
          "  - npm run lint && npm run format:check\n",
          "",
        ),
      ),
      MissionErrorCode.VerificationUncovered,
      FOUNDATION,
    );
  },
);

todoapp("EF06.13 a node with no task holds an empty task list", async (h) => {
  const { project } = await h.baseline();
  const contributing = byFilename(await h.nodes(project))[CONTRIBUTING]!;
  assert.deepEqual((await h.node(contributing.id)).tasks, []);
});

todoapp("EF06.14 a dependency cycle is refused", async (h) => {
  const project = await h.todoappProject();
  await h.refusedImport(
    project,
    h.planFiles((files) =>
      replaced(
        files,
        FOUNDATION,
        "depends_on: []",
        `depends_on:\n  - ${TODO_API}`,
      ),
    ),
    MissionErrorCode.Cycle,
  );
});

todoapp(
  "EF06.15 a requirement that no worker binding meets is refused",
  async (h) => {
    const project = await h.todoappProject();
    const found = await h.refusedImport(
      project,
      h.planFiles((files) =>
        replaced(
          files,
          FOUNDATION,
          "depends_on: []",
          "depends_on: []\nrequires: [platform.macos]",
        ),
      ),
      MissionErrorCode.RequiresUnmatched,
      FOUNDATION,
    );
    const details = found[0]!.details as { claims: unknown[] };
    assert.notEqual(details.claims.length, NO_ITEMS);
  },
);

todoapp(
  "EF06.16 a second repository binding on an implement node is refused",
  async (h) => {
    const project = await h.todoappProject();
    await h.write(["project", "binding", "apply", project.projectId], {
      version: await h.bindingSetVersion(project),
      bindings: {
        ...COVERING_WORKER_BINDINGS,
        [REPOSITORY_BINDING]: repositoryBinding(REPOSITORY_BINDING, ACTION),
        [MIRROR_BINDING]: repositoryBinding(MIRROR_BINDING, ACTION),
      },
    });
    await h.refusedImport(
      project,
      h.planFiles((files) =>
        replaced(
          files,
          TODOS,
          bindingNames([REPOSITORY_BINDING]),
          bindingNames([REPOSITORY_BINDING, MIRROR_BINDING]),
        ),
      ),
      MissionErrorCode.BindingsInvalid,
    );
  },
);

todoapp(
  "EF06.17 an import prepared before a human write is refused and the write survives",
  async (h) => {
    const { project } = await h.baseline();
    const { version, paths } = await h.exported(project);
    const operations = paths.find((path) =>
      path.endsWith("operations-errors.md"),
    )!;
    writeFileSync(
      operations,
      `${readFileSync(operations, UTF8).trimEnd()}\n${NEW_CRITERION}\n`,
    );
    const prepared = await h.preview(project, paths, version);
    assert.deepEqual(prepared.violations, []);
    const todos = byFilename(await h.nodes(project))[TODOS]!;
    await h.update(project, todos, { criterion: UPDATED_CRITERION });
    await h.refuses(
      ["mission", "import", "apply", project.missionId, ...paths],
      {
        format: ImportFormat.Markdown,
        mission_version: version,
        reason: REASON,
        preview_digest: prepared.preview_digest,
        confirmed_retirements: [],
      },
      MissionErrorCode.VersionConflict,
    );
    assert.equal((await h.node(todos.id)).content.criterion, UPDATED_CRITERION);
  },
);

todoapp(
  "EF06.18 a task criterion edit before the start revises only its node",
  async (h) => {
    const { project } = await h.baseline();
    const before = await h.nodes(project);
    const { version, paths } = await h.exported(project);
    const task = paths.find((path) => path.endsWith(TODOS_CRUD))!;
    writeFileSync(
      task,
      `${readFileSync(task, UTF8).trimEnd()}\n${NEW_CRITERION}\n`,
    );
    const previewed = await h.preview(project, paths, version);
    assert.deepEqual(previewed.violations, []);
    await h.apply(project, paths, previewed);
    const after = byFilename(await h.nodes(project));
    const todos = byFilename(before)[TODOS]!;
    assert.equal(after[TODOS]!.visible_revision, SECOND_REVISION);
    assert.deepEqual(
      after[TODOS]!.tasks.map((item) => item.id),
      todos.tasks.map((item) => item.id),
    );
    for (const name of Object.keys(after).filter((file) => file !== TODOS))
      assert.deepEqual(after[name], byFilename(before)[name], name);
  },
);

todoapp(
  "EF06.19 an omitted task revises its node and an omitted node retires with its edges",
  async (h) => {
    const { project } = await h.baseline();
    const before = byFilename(await h.nodes(project));
    const { version, paths } = await h.exported(project);
    const without = (name: string) =>
      paths.filter((path) => !path.endsWith(`/${name}`));
    const taskOmission = await h.preview(
      project,
      without(TODOS_ISOLATION),
      version,
    );
    assert.deepEqual(taskOmission.violations, []);
    assert.deepEqual(taskOmission.retirements, []);
    assert.deepEqual(taskOmission.updates, [before[TODOS]!.id]);
    const nodeOmission = await h.preview(project, without(TODO_API), version);
    assert.deepEqual(nodeOmission.violations, []);
    assert.deepEqual(nodeOmission.retirements, [before[TODO_API]!.id]);
    await h.apply(
      project,
      without(TODO_API),
      nodeOmission,
      nodeOmission.retirements,
    );
    const retired = await h.node(before[TODO_API]!.id);
    assert.ok(retired.retired_at !== null);
    assert.equal((await h.edges(project)).length, RETIRED_EDGE_COUNT);
  },
);

todoapp(
  "EF06.20 the initial queue holds one job of foundation and no task",
  async (h) => {
    const { project } = await h.baseline();
    const all = byFilename(await h.nodes(project));
    const queued = await h.jobs(project);
    assert.deepEqual(
      queued.map((job) => job.node_id),
      [all[FOUNDATION]!.id],
    );
    assert.equal((await h.node(all[TODO_API]!.id)).state, NodeState.Pending);
    assert.ok(!JSON.stringify(queued).includes(TASK_IDENTITY_PREFIX));
  },
);

todoapp(
  "EF06.21 the success overrides release the nodes in dependency order",
  async (h) => {
    const { project } = await h.baseline();
    const { ids } = await h.overrideInOrder(project, (step, queued) =>
      assert.deepEqual(queued, QUEUE_AFTER_OVERRIDE[step]),
    );
    assert.equal((await h.node(ids[TODO_API]!)).state, NodeState.Available);
  },
);

todoapp(
  "EF06.22 the work of a node with an open attempt is locked",
  async (h) => {
    const { project } = await h.baseline();
    const foundation = byFilename(await h.nodes(project))[FOUNDATION]!;
    const readied = await h.control("ready", foundation.id, project);
    assert.equal(readied.node.state, NodeState.Waiting);
    const current = await h.node(foundation.id);
    await h.refuses(
      ["mission", "node", "update", foundation.id],
      {
        filename: current.filename,
        content: { ...current.content, work: Work.Examine },
        tasks: current.tasks,
        reason: REASON,
        expected_revision: current.visible_revision,
        expected_mission_version: await h.missionVersion(project),
      },
      MissionErrorCode.WorkLocked,
    );
    assert.equal(
      (await h.node(foundation.id)).visible_revision,
      current.visible_revision,
    );
  },
);

todoapp(
  "EF06.23 a binding set with no reviewer is refused for every node",
  async (h) => {
    const { project } = await h.baseline();
    const all = await h.nodes(project);
    const version = await h.bindingSetVersion(project);
    const bindings = {
      coder: COVERING_WORKER_BINDINGS.coder,
      [REPOSITORY_BINDING]: repositoryBinding(REPOSITORY_BINDING, ACTION),
    };
    await h.refuses(
      ["project", "binding", "apply", project.projectId],
      { version, bindings },
      ProjectErrorCode.WorkerNodeUnmatched,
    );
    const failure = await h.failedBindingSet(project, bindings);
    assert.equal(failure.code, ProjectErrorCode.WorkerNodeUnmatched);
    const details = failure.details as { node_ids: string[] };
    assert.deepEqual(
      details.node_ids.slice().sort(),
      all.map((i) => i.id).sort(),
    );
    assert.equal(all.length, NODE_COUNT);
    assert.equal(await h.bindingSetVersion(project), version);
  },
);

todoapp("EF06.24 no job and no execution names a task", async (h) => {
  const { project } = await h.baseline();
  await h.overrideInOrder(project);
  const executions = await h.read<Page<unknown>>([
    "scheduler",
    "execution",
    "list",
    project.projectId,
  ]);
  const names = [await h.jobs(project), executions.items];
  for (const listed of names)
    assert.ok(!JSON.stringify(listed).includes(TASK_IDENTITY_PREFIX));
});
