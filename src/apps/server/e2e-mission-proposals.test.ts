import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { httpClient } from "../../gateway/client.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  AssessmentResult,
  AssetKind,
  MissionErrorCode,
  NodeKind,
  NodeState,
  missionOperations,
  type Assessment,
  type ControlResult,
  type Mission,
  type Node,
  type NodeChange,
  type Outcome,
  type Proposal,
  type Revision,
} from "../../mission/contract.ts";
import { FAKE_SSH_IDENTITY, gatewayFixture } from "./test-support.ts";
import {
  cliMachine,
  cliSession,
  completed,
  createCredentials,
  executionContext,
  kanthord,
  passingEvaluation,
  repositorySnapshot,
} from "./cli-support.ts";

const FAILURE_EXIT_CODE = 1;
const INITIAL_FILE_NUMBER = 0;
const EMPTY_OUTPUT = "";
const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const SINGLE_ITEM = 1;
const TWO_REVISIONS = 2;
const NO_ITEMS = 0;
const WORKER_INSTANCE_COUNT = 1;
const TIMEOUT = 300000;
const NUMBER_TYPE = "number";
const SECRET = "test-secret";
const REPOSITORY = "repo";
const HARNESS = "harness";
const COMMIT = "a".repeat(40);
const UNAUTHORIZED_ERROR_CODE = "gateway.authentication.unauthorized";
const PROPOSAL_NAME = "Fix accounts";
const PROPOSAL_REQUIREMENT = "Repair the recovery flow";
const PROPOSAL_CRITERION = "Recovery works";
const TASK_NAME = "Repair";
const TASK_VERIFICATIONS = ["pnpm test"];
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
};
type Page<T> = { items: T[]; next_cursor: string | null };
type Binding = { id: string; name: string; resource_identity: string };
type Failure = Extract<
  OperationResult<unknown>,
  { type: typeof OperationResultType.Failure }
>;

function refused(result: OperationResult<unknown>, status: number): Failure {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  return result;
}

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
  });
  const session = cliSession(t, fixture.endpoint, fixture.token, SECRET);
  const { read, write } = session;
  await createCredentials(session, SECRET);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "proposals",
  ]);
  const mission = await read<Mission>(["mission", "get", project.id]);
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      [REPOSITORY]: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          strategy: { base_branch: "main" },
          ssh_credential: "github-ssh",
          credential: "github",
        },
      },
      [HARNESS]: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: WORKER_INSTANCE_COUNT },
      },
    },
  });
  const bindings = await read<Page<Binding>>([
    "project",
    "binding",
    "list",
    project.id,
  ]);
  const binding = (name: string) =>
    bindings.items.find((x) => x.name === name)!;
  const missionVersion = async () =>
    (await read<Mission>(["mission", "get", project.id])).version;
  const create = async (
    filename: string,
    kind: string,
    names: string[],
    parentId?: string,
  ) => {
    const change = await write<NodeChange>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        kind,
        content: {
          ...CONTENT,
          bindings: names.map((name) => binding(name).id),
        },
        reason: "plan",
        expected_mission_version: await missionVersion(),
        ...(parentId
          ? { parent_id: parentId, expected_parent_revision: FIRST_REVISION }
          : {}),
      },
    );
    return change.revisions[FIRST_INDEX]!.node_id;
  };
  const initiativeId = await create("initiative.md", NodeKind.Initiative, []);
  const objectiveId = await create(
    "objective.md",
    NodeKind.Objective,
    [REPOSITORY],
    initiativeId,
  );
  const machine = await cliMachine(session, {
    masterKey: fixture.config.master_key,
    projectId: project.id,
    resourceIdentity: binding(HARNESS).resource_identity,
  });
  await passingEvaluation(session, machine, {
    nodeId: objectiveId,
    bindingId: binding(REPOSITORY).id,
    commit: COMMIT,
  });
  assert.equal((await machine.node(objectiveId)).state, NodeState.Completed);
  const outcomes = await read<Page<Outcome>>([
    "mission",
    "outcome",
    "list",
    objectiveId,
  ]);
  const produced = [
    {
      kind: AssetKind.Produced,
      content: { media_type: "text/plain", encoding: "base64", data: "b2s=" },
    },
  ];
  const steps = await machine.pull(initiativeId, NodeState.Executing);
  await write(
    ["mission", "evidence", "submit", initiativeId],
    { ...executionContext(steps), subject: "review notes", assets: produced },
    machine.T,
  );
  await machine.release(steps.execution_id);
  const evaluation = await machine.pull(initiativeId, NodeState.Evaluating);
  const run = await write<{ evidence: { id: string } }>(
    ["mission", "evidence", "submit", initiativeId],
    {
      ...executionContext(evaluation),
      subject: "verification run",
      assets: produced,
      verification: {
        tested_input: [repositorySnapshot(binding(REPOSITORY).id, COMMIT)],
        results: [
          { command: "true", exit_code: 0, signal: null, timed_out: false },
        ],
      },
    },
    machine.T,
  );
  const judged = await write<{ assessment: Assessment; node: Node }>(
    ["mission", "assessment", "submit", initiativeId],
    {
      ...executionContext(evaluation),
      evidence_ids: [run.evidence.id],
      child_outcome_ids: outcomes.items.map((outcome) => outcome.id),
      result: AssessmentResult.Undetermined,
      rationale: "Recovery is incomplete",
      tested_input: [repositorySnapshot(binding(REPOSITORY).id, COMMIT)],
      proposals: [
        {
          objective_id: objectiveId,
          name: PROPOSAL_NAME,
          requirement: PROPOSAL_REQUIREMENT,
          criterion: PROPOSAL_CRITERION,
          task: {
            name: TASK_NAME,
            requirement: "Change the code",
            criterion: "The test passes",
            verifications: TASK_VERIFICATIONS,
          },
        },
      ],
    },
    machine.T,
  );
  return {
    fixture,
    session,
    machine,
    project,
    initiativeId,
    objectiveId,
    repositoryId: binding(REPOSITORY).id,
    missionVersion,
    judged,
  };
}

test(
  "Mission fix-objective proposals through the CLI and the HTTP routes",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const { read, write } = h.session;
    const human = httpClient(
      missionOperations,
      h.fixture.endpoint,
      h.fixture.token,
    );
    const machine = httpClient(
      missionOperations,
      h.fixture.endpoint,
      h.machine.token,
    );
    const listArguments = (...options: string[]) => [
      "mission",
      "proposal",
      "list",
      h.initiativeId,
      ...options,
    ];
    const directory = temporary(t);
    let fileNumber = INITIAL_FILE_NUMBER;
    const approveArguments = (proposalId: string, version: number) => {
      const path = join(directory, `${++fileNumber}.json`);
      writePrivate(path, JSON.stringify({ expected_mission_version: version }));
      return ["mission", "proposal", "approve", proposalId, "--file", path];
    };
    const approveRefused = async (
      proposalId: string,
      version: number,
      code: string,
    ) => {
      const result = await kanthord(
        approveArguments(proposalId, version),
        h.session.H,
      );
      assert.equal(result.code, FAILURE_EXIT_CODE, result.stderr);
      assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
      assert.equal(result.stdout, EMPTY_OUTPUT);
    };
    let proposal!: Proposal;
    let approved!: { objective: NodeChange; initiative: ControlResult };

    await t.test("the initiative judgement blocks the initiative", () => {
      assert.equal(h.judged.assessment.result, AssessmentResult.Undetermined);
      assert.equal(
        (h.judged.node as { state: string }).state,
        NodeState.Blocked,
      );
    });

    await t.test("proposal list answers the open proposal", async () => {
      const page = await read<Page<Proposal>>(listArguments());
      assert.equal(page.items.length, SINGLE_ITEM);
      assert.equal(page.next_cursor, null);
      proposal = page.items[FIRST_INDEX]!;
      assert.equal(proposal.node_id, h.initiativeId);
      assert.equal(proposal.attempt, FIRST_ATTEMPT);
      assert.equal(proposal.approved_at, null);
      assert.equal(proposal.objective_node_id, null);
      assert.equal(proposal.content.objective_id, h.objectiveId);
      assert.equal(proposal.content.name, PROPOSAL_NAME);
      assert.deepEqual(proposal.content.task.verifications, TASK_VERIFICATIONS);
    });

    await t.test("proposal list filters by attempt", async () => {
      const matching = await read<Page<Proposal>>(
        listArguments("--attempt", String(FIRST_ATTEMPT)),
      );
      assert.deepEqual(
        matching.items.map((item) => item.id),
        [proposal.id],
      );
      const other = await read<Page<Proposal>>(
        listArguments("--attempt", String(SECOND_ATTEMPT)),
      );
      assert.equal(other.items.length, NO_ITEMS);
    });

    await t.test("a stale mission version refuses the approval", async () => {
      await approveRefused(
        proposal.id,
        (await h.missionVersion()) + SINGLE_ITEM,
        MissionErrorCode.VersionConflict,
      );
      const refusal = refused(
        await human["proposal.approve"](
          {
            params: { proposal_id: proposal.id },
            query: {},
            body: { expected_mission_version: FIRST_REVISION },
          },
          { idempotencyKey: ulid() },
        ),
        HttpStatus.Conflict,
      );
      assert.equal(refusal.error.error.code, MissionErrorCode.VersionConflict);
    });

    await t.test("a machine token is refused on both routes", async () => {
      const list = refused(
        await machine["proposal.list"]({
          params: { node_id: h.initiativeId },
          query: {},
          body: null,
        }),
        HttpStatus.Unauthorized,
      );
      assert.equal(list.error.error.code, UNAUTHORIZED_ERROR_CODE);
      const approve = refused(
        await machine["proposal.approve"](
          {
            params: { proposal_id: proposal.id },
            query: {},
            body: { expected_mission_version: await h.missionVersion() },
          },
          { idempotencyKey: ulid() },
        ),
        HttpStatus.Unauthorized,
      );
      assert.equal(approve.error.error.code, UNAUTHORIZED_ERROR_CODE);
      const open = await read<Page<Proposal>>(listArguments());
      assert.equal(open.items[FIRST_INDEX]!.approved_at, null);
    });

    await t.test("a human token lists the proposal over HTTP", async () => {
      const page = completed(
        await human["proposal.list"]({
          params: { node_id: h.initiativeId },
          query: {},
          body: null,
        }),
      );
      assert.deepEqual(page.items, [proposal]);
    });

    await t.test("approval creates the objective and its task", async () => {
      approved = await write<typeof approved>(
        ["mission", "proposal", "approve", proposal.id],
        { expected_mission_version: await h.missionVersion() },
      );
      assert.equal(approved.objective.revisions.length, TWO_REVISIONS);
      const [created, tasked] = approved.objective.revisions as [
        Revision,
        Revision,
      ];
      const objectiveId = created.node_id;
      assert.equal(tasked.node_id, objectiveId);
      assert.equal(tasked.content.name, PROPOSAL_NAME);
      assert.equal(tasked.tasks?.length, SINGLE_ITEM);
      const taskContent = tasked.tasks![FIRST_INDEX]!;
      assert.equal(taskContent.content.name, TASK_NAME);
      const objective = await read<Node>([
        "mission",
        "node",
        "get",
        objectiveId,
      ]);
      assert.equal(objective.kind, NodeKind.Objective);
      assert.equal(objective.parent_id, h.initiativeId);
      assert.deepEqual(objective.content.bindings, [h.repositoryId]);
      const task = await read<Node>(["mission", "node", "get", taskContent.id]);
      assert.equal(task.kind, NodeKind.Task);
      assert.equal(task.parent_id, objectiveId);
      const listed = await read<Page<Proposal>>(listArguments());
      assert.equal(typeof listed.items[FIRST_INDEX]!.approved_at, NUMBER_TYPE);
      assert.equal(listed.items[FIRST_INDEX]!.objective_node_id, objectiveId);
    });

    await t.test("the initiative reopens in a new attempt", async () => {
      const { node } = approved.initiative;
      assert.ok(node.kind === NodeKind.Initiative);
      assert.equal(node.state, NodeState.Available);
      assert.equal(node.attempt, SECOND_ATTEMPT);
      const queue = await read<Page<{ node_id: string }>>([
        "scheduler",
        "queue",
        "list",
        h.project.id,
      ]);
      const queued = queue.items.map((item) => item.node_id);
      assert.ok(
        queued.includes(approved.objective.revisions[FIRST_INDEX]!.node_id),
      );
      assert.ok(!queued.includes(h.initiativeId));
    });

    await t.test("a second approval answers already approved", async () => {
      await approveRefused(
        proposal.id,
        await h.missionVersion(),
        MissionErrorCode.ProposalAlreadyApproved,
      );
      const refusal = refused(
        await human["proposal.approve"](
          {
            params: { proposal_id: proposal.id },
            query: {},
            body: { expected_mission_version: await h.missionVersion() },
          },
          { idempotencyKey: ulid() },
        ),
        HttpStatus.Conflict,
      );
      assert.equal(
        refusal.error.error.code,
        MissionErrorCode.ProposalAlreadyApproved,
      );
    });
  },
);
