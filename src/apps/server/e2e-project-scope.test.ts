import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createIdempotencyKey, createIdentity } from "../../kernel/identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import type { Operation } from "../../kernel/operation.ts";
import {
  testGuestIdentity,
  testHumanIdentity,
  testReadOnlyIdentity,
} from "../../kernel/test-identity.ts";
import {
  ImportFormat,
  Intent,
  missionOperations,
} from "../../mission/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { environment } from "./cli-test-support.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  applyCoveringBindings,
  completed as completedResult,
  createHost,
  enableCoveringAgents,
  gatewayFixture,
  workbenchHarness,
} from "./test-support.ts";

const TEST_TIMEOUT_MS = 60000;
const ACCOUNT = "kanthord";
const SCOPE_NOT_FOUND = "gateway.scope.not_found";
const SCOPE_REFUSED = "gateway.scope.refused";
const UNKNOWN_ID = "mission.import.unknown_id";
const REQUEST_ID = createIdentity("request");
const CONTENT = {
  name: "Plan",
  requirement: "Do the work",
  criterion: "Work is done",
  verifications: ["Check result"],
  bindings: [],
};
const TASK_CONTENT = { ...CONTENT, name: "Task" };
const ID_KEY = "id";
const NO_ITEMS = 0;
const ONE_ITEM = 1;

interface Created {
  id: string;
  version: number;
  mission_version: number;
  revisions: { node_id: string }[];
}

interface Answer {
  status: number;
  body: unknown;
}

function codeOf(answer: Answer): string {
  return (answer.body as { error: { code: string } }).error.code;
}

async function scopeFixture(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const human = { authorization: `Bearer ${fixture.token}` };
  const call = async (
    operation: Operation,
    input: unknown,
    options: object = human,
  ): Promise<Answer> => {
    const answer = await fixture.invocation.invoke(operation.id, input, {
      idempotencyKey: createIdempotencyKey(),
      requestId: REQUEST_ID,
      ...options,
    });
    return { status: answer.status, body: answer.body };
  };
  const completed = async (operation: Operation, input: unknown) => {
    const answer = await call(operation, input);
    assert.ok(answer.status < HttpStatus.BadRequest, JSON.stringify(answer));
    return answer.body as Created;
  };
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  await enableCoveringAgents(env);
  const projectOf = async (name: string) => {
    const project = await completed(projectOperations.create, {
      params: {},
      query: {},
      body: { name },
    });
    await applyCoveringBindings(env, directory, project.id);
    const mission = await completed(missionOperations.get, {
      params: { project_id: project.id },
      query: {},
      body: null,
    });
    const created = await completed(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename: "plan-1.md",
        content: { ...CONTENT, intent: Intent.Examine },
        tasks: [],
        reason: "plan",
        expected_mission_version: mission.version,
      },
    });
    const taskId = createIdentity("task");
    fixture.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE mission_node_revision SET tasks = ? WHERE node_id = ?")
        .run(
          JSON.stringify([
            { id: taskId, filename: "task-1.md", content: TASK_CONTENT },
          ]),
          created.revisions[0]!.node_id,
        ),
    );
    return {
      projectId: project.id,
      missionId: mission.id,
      missionVersion: created.mission_version,
      nodeId: created.revisions[0]!.node_id as string,
      taskId,
    };
  };
  const first = await projectOf("scope-one");
  const second = await projectOf("scope-two");
  const inviteId = createIdentity("workbench_invite");
  const projectIds = [first.projectId];
  fixture.store.transaction((tx) =>
    tx.database
      .prepare(
        "INSERT INTO workbench_invite (id, session_id, token_hash, invited_by, invited_by_name, expires_at, invitee_name, project_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        inviteId,
        createIdentity("workbench_session"),
        randomUUID(),
        ACCOUNT,
        ACCOUNT,
        Date.now() + TEST_TIMEOUT_MS,
        "Mira",
        JSON.stringify(projectIds),
      ),
  );
  const reader = testReadOnlyIdentity(ACCOUNT, { inviteId, projectIds });
  const scoped = (operation: Operation, input: unknown) =>
    call(operation, input, { identity: reader });
  return { call, scoped, first, second };
}

const read = <P extends object>(params: P, query: object = {}) => ({
  params,
  query,
  body: null,
});

test(
  "(happy path) a scoped read of a node of the invite project answers the node",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { scoped, first } = await scopeFixture(t);
    const answer = await scoped(
      missionOperations["node.get"],
      read({ node_id: first.nodeId }),
    );
    assert.equal(answer.status, HttpStatus.OK);
    assert.equal((answer.body as { id: string }).id, first.nodeId);
  },
);

test(
  "(security) a foreign and an absent node answer byte-equal 404 bodies, and a global read answers 403",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { scoped, second } = await scopeFixture(t);
    const foreign = await scoped(
      missionOperations["node.get"],
      read({ node_id: second.nodeId }),
    );
    const absent = await scoped(
      missionOperations["node.get"],
      read({ node_id: createIdentity("node") }),
    );
    assert.equal(foreign.status, HttpStatus.NotFound);
    assert.equal(codeOf(foreign), SCOPE_NOT_FOUND);
    assert.equal(JSON.stringify(foreign.body), JSON.stringify(absent.body));
    const credentials = await scoped(llmOperations.list, read({}));
    assert.equal(credentials.status, HttpStatus.Forbidden);
    assert.equal(codeOf(credentials), SCOPE_REFUSED);
  },
);

test(
  "(security) project.list answers the invite project only",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { scoped, first, second } = await scopeFixture(t);
    const answer = await scoped(projectOperations.list, read({}));
    const page = answer.body as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    assert.deepEqual(
      page.items.map((item) => item.id),
      [first.projectId],
    );
    assert.equal(page.next_cursor, null);
    const foreign = await scoped(
      projectOperations.list,
      read({}, { id: [second.projectId] }),
    );
    assert.deepEqual(foreign.body, { items: [], next_cursor: null });
  },
);

test(
  "(security) worker.instance.list and a markdown import preview answer 403",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { scoped, first } = await scopeFixture(t);
    const instances = await scoped(workerOperations["instance.list"], read({}));
    assert.equal(instances.status, HttpStatus.Forbidden);
    const preview = await scoped(missionOperations["import.preview"], {
      params: { mission_id: first.missionId },
      query: {},
      body: {
        format: ImportFormat.Markdown,
        mission_id: first.missionId,
        mission_version: first.missionVersion,
        reason: "preview",
        files: [],
      },
    });
    assert.equal(preview.status, HttpStatus.Forbidden);
    assert.equal(codeOf(preview), SCOPE_REFUSED);
  },
);

test(
  "(security) a foreign cursor and an absent cursor answer the same page on each scoped list",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { scoped, first, second } = await scopeFixture(t);
    const cursorOf = (id: string) => Buffer.from(id).toString("base64url");
    const lists = [
      [projectOperations.list, {}, "project", second.projectId],
      [
        missionOperations["node.list"],
        { mission_id: first.missionId },
        "node",
        second.nodeId,
      ],
      [
        projectOperations["binding.list"],
        { project_id: first.projectId },
        "binding",
        createIdentity("binding"),
      ],
      [
        schedulerOperations.executionList,
        { project_id: first.projectId },
        "execution",
        createIdentity("execution"),
      ],
      [
        schedulerOperations.queueList,
        { project_id: first.projectId },
        "job",
        createIdentity("job"),
      ],
      [
        missionOperations["evidence.list"],
        { node_id: first.nodeId },
        "evidence",
        createIdentity("evidence"),
      ],
      [
        missionOperations["assessment.list"],
        { node_id: first.nodeId },
        "assessment",
        createIdentity("assessment"),
      ],
      [
        missionOperations["proposal.list"],
        { node_id: first.nodeId },
        "proposal",
        createIdentity("proposal"),
      ],
    ] as const;
    for (const [operation, params, prefix, foreignId] of lists) {
      const withForeign = await scoped(
        operation,
        read(params, { cursor: cursorOf(foreignId) }),
      );
      const withAbsent = await scoped(
        operation,
        read(params, { cursor: cursorOf(createIdentity(prefix)) }),
      );
      assert.equal(withForeign.status, withAbsent.status, operation.id);
      assert.equal(
        JSON.stringify(withForeign.body),
        JSON.stringify(withAbsent.body),
        operation.id,
      );
    }
  },
);

test(
  "(security) a task id of another project answers mission.import.unknown_id like an absent task id",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { scoped, first, second } = await scopeFixture(t);
    const preview = (taskId: string) =>
      scoped(missionOperations["import.preview"], {
        params: { mission_id: first.missionId },
        query: {},
        body: {
          format: ImportFormat.Json,
          mission_id: first.missionId,
          mission_version: first.missionVersion,
          reason: "preview",
          entries: [
            {
              ...TASK_CONTENT,
              filename: "task-9.md",
              id: taskId,
              node: "plan-1.md",
            },
          ],
        },
      });
    const foreign = await preview(second.taskId);
    const absent = await preview(createIdentity("task"));
    assert.equal(foreign.status, HttpStatus.OK);
    const violationsOf = (answer: Answer) =>
      (
        answer.body as {
          violations: { code: string; details: { id: string } }[];
        }
      ).violations.filter((violation) => violation.code === UNKNOWN_ID);
    assert.equal(violationsOf(foreign).length, ONE_ITEM);
    assert.notEqual(violationsOf(foreign).length, NO_ITEMS);
    const withoutId = (answer: Answer) =>
      JSON.stringify(violationsOf(answer), (key, value: unknown) =>
        key === ID_KEY ? undefined : value,
      );
    assert.equal(withoutId(foreign), withoutId(absent));
  },
);

const OWNER = testHumanIdentity(ACCOUNT, "Ulrich", "project-scope");
const OPS = "ops@1";
const GUEST_NAME = "Mira";
const FIRST_NAME = "scope-one";
const RENAMED = "scope-one-renamed";

test(
  "(happy path) invite.list and guest.get answer the project names live after a rename, and invite.list answers the live set",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { conversationFixture } = workbenchHarness(OWNER);
    const { fixture } = await conversationFixture(t, []);
    const created = await Promise.all(
      [FIRST_NAME, "scope-two"].map(async (name) =>
        completedResult(
          await fixture.projects.create(
            { params: {}, query: {}, body: { name } },
            fixture.options,
          ),
        ),
      ),
    );
    const projectIds = created.map((project) => project.id).sort();
    const host = await createHost(fixture, OPS);
    const listInvites = async () =>
      completedResult(
        await fixture.workbench["invite.list"](
          { params: { session_id: host.id }, query: {}, body: null },
          fixture.options,
        ),
      );
    assert.equal((await listInvites()).project_ids, null);
    const invite = completedResult(
      await fixture.workbench["invite.create"](
        {
          params: { session_id: host.id },
          query: {},
          body: { invitee_name: GUEST_NAME, project_ids: projectIds },
        },
        fixture.options,
      ),
    );
    const renamed = created.find((project) => project.name === FIRST_NAME)!;
    completedResult(
      await fixture.projects.rename(
        {
          params: { project_id: renamed.id },
          query: {},
          body: { name: RENAMED },
        },
        fixture.options,
      ),
    );
    const listed = await listInvites();
    assert.deepEqual(listed.project_ids, projectIds);
    const nameOf = (projects: { id: string; name: string | null }[]) =>
      projects.find((project) => project.id === renamed.id)?.name;
    assert.equal(nameOf(listed.items[0]!.projects), RENAMED);
    const guest = testGuestIdentity({
      guestId: createIdentity("workbench_guest"),
      name: GUEST_NAME,
      inviteId: invite.id,
      sessionId: host.id,
      invitedBy: ACCOUNT,
      reader: testReadOnlyIdentity(ACCOUNT, {
        inviteId: invite.id,
        projectIds,
      }),
      jti: "guest",
    });
    const seen = await fixture.workbenchService.guestGet(guest);
    assert.equal(nameOf(seen.projects), RENAMED);
    completedResult(
      await fixture.workbench["invite.revoke"](
        { params: { invite_id: invite.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    assert.equal((await listInvites()).project_ids, null);
  },
);
