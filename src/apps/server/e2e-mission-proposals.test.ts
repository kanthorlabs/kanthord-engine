import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { httpClient } from "../../gateway/client.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  type Assessment,
  AssessmentResult,
  AssetKind,
  Intent,
  type Mission,
  MissionErrorCode,
  missionOperations,
  type Node,
  type NodeChange,
  NodeState,
  type Outcome,
  type Proposal,
  type ProposalDecideResult,
  TASK_IDENTITY_PREFIX,
} from "../../mission/contract.ts";
import { gatewayFixture } from "./test-support.ts";
import {
  cliMachine,
  cliSession,
  completed,
  createCredentials,
  executionContext,
  kanthord,
  passingEvaluation,
  repositorySnapshot,
} from "./cli-test-support.ts";
import { createIdempotencyKey, createIdentity } from "../../kernel/identity.ts";

const FAILURE_EXIT_CODE = 1;
const INITIAL_FILE_NUMBER = 0;
const EMPTY_OUTPUT = "";
const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const SINGLE_ITEM = 1;
const TWO_ITEMS = 2;
const SUCCESS_EXIT_CODE = 0;
const NO_ITEMS = 0;
const WORKER_INSTANCE_COUNT = 1;
const TIMEOUT = 300000;
const NUMBER_TYPE = "number";
const STRING_TYPE = "string";
const SECRET = "test-secret";
const REPOSITORY = "repo";
const HARNESS = "harness";
const COMMIT = "a".repeat(40);
const UNAUTHORIZED_ERROR_CODE = "gateway.authentication.unauthorized";
const PROPOSAL_NAME = "Fix accounts";
const SECOND_PROPOSAL_NAME = "Fix sessions";
const THIRD_PROPOSAL_NAME = "Fix tokens";
const DECISION_REASON = "Two fixes cover the defect.";
const VALIDATION_ERROR_CODE = "gateway.request.validation_failed";
const INVALID_ASSESSMENT_ARGUMENT = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INVALID_ASSESSMENT_ID_CODE =
  "cli.mission.proposal.decide.invalid_assessment_id";
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

async function setup(t: TestContext, proposalNames: string[]) {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
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
        config: {
          worker: "claude-code@1",
          instance_count: WORKER_INSTANCE_COUNT,
        },
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
    intent: Intent,
    names: string[],
    dependentId?: string,
  ) => {
    const change = await write<NodeChange>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        content: {
          ...CONTENT,
          intent,
          bindings: names.map((name) => binding(name).id),
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: await missionVersion(),
      },
    );
    const nodeId = change.revisions[FIRST_INDEX]!.node_id;
    if (dependentId)
      await write(["mission", "dependency", "add", dependentId, nodeId], {
        reason: "plan",
        expected_mission_version: await missionVersion(),
      });
    return nodeId;
  };
  const examineId = await create("examine.md", Intent.Examine, [REPOSITORY]);
  const implementId = await create(
    "implement.md",
    Intent.Implement,
    [REPOSITORY],
    examineId,
  );
  const machine = await cliMachine(session, {
    masterKey: fixture.config.master_key,
    projectId: project.id,
    resourceIdentity: binding(HARNESS).resource_identity,
  });
  await passingEvaluation(session, machine, {
    nodeId: implementId,
    bindingId: binding(REPOSITORY).id,
    commit: COMMIT,
  });
  assert.equal((await machine.node(implementId)).state, NodeState.Completed);
  const outcomes = await read<Page<Outcome>>([
    "mission",
    "outcome",
    "list",
    implementId,
  ]);
  const produced = [
    {
      kind: AssetKind.Produced,
      content: { media_type: "text/plain", encoding: "base64", data: "b2s=" },
    },
  ];
  const steps = await machine.pull(examineId, NodeState.Executing);
  await write(
    ["mission", "evidence", "submit", examineId],
    { ...executionContext(steps), subject: "review notes", assets: produced },
    machine.T,
  );
  await machine.release(steps.execution_id);
  const evaluation = await machine.pull(examineId, NodeState.Evaluating);
  const run = await write<{ evidence: { id: string } }>(
    ["mission", "evidence", "submit", examineId],
    {
      ...executionContext(evaluation),
      subject: "verification run",
      assets: produced,
      verification: {
        tested_input: repositorySnapshot(binding(REPOSITORY).id, COMMIT),
        results: [
          { command: "true", exit_code: 0, signal: null, timed_out: false },
        ],
      },
    },
    machine.T,
  );
  const judged = await write<{ assessment: Assessment; node: Node }>(
    ["mission", "assessment", "submit", examineId],
    {
      ...executionContext(evaluation),
      evidence_ids: [run.evidence.id],
      dependency_outcome_ids: outcomes.items.map((outcome) => outcome.id),
      result: AssessmentResult.Undetermined,
      rationale: "Recovery is incomplete",
      tested_input: repositorySnapshot(binding(REPOSITORY).id, COMMIT),
      proposals: proposalNames.map((name) => ({
        dependency_id: implementId,
        name,
        requirement: PROPOSAL_REQUIREMENT,
        criterion: PROPOSAL_CRITERION,
        task: {
          name: TASK_NAME,
          requirement: "Change the code",
          criterion: "The test passes",
          verifications: TASK_VERIFICATIONS,
        },
      })),
    },
    machine.T,
  );
  return {
    fixture,
    session,
    machine,
    project,
    examineId,
    implementId,
    repositoryId: binding(REPOSITORY).id,
    missionVersion,
    judged,
  };
}

function proposalsByName(page: Page<Proposal>): Map<string, Proposal> {
  return new Map(page.items.map((item) => [item.content.name, item]));
}

test(
  "Mission fix-node proposals through the CLI and the HTTP routes",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t, [PROPOSAL_NAME, SECOND_PROPOSAL_NAME]);
    const { read } = h.session;
    const assessmentId = h.judged.assessment.id;
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
    const decideOver = (
      client: typeof human,
      approvedProposalIds: string[],
      version: number,
    ) =>
      client["proposal.decide"](
        {
          params: { assessment_id: assessmentId },
          query: {},
          body: {
            expected_mission_version: version,
            approved_proposal_ids: approvedProposalIds,
          },
        },
        { idempotencyKey: createIdempotencyKey() },
      );
    const listArguments = (...options: string[]) => [
      "mission",
      "proposal",
      "list",
      h.examineId,
      ...options,
    ];
    let proposals!: Map<string, Proposal>;
    let decided!: ProposalDecideResult;

    await t.test("the examine judgement blocks the examine node", () => {
      assert.equal(h.judged.assessment.result, AssessmentResult.Undetermined);
      assert.equal(
        (h.judged.node as { state: string }).state,
        NodeState.Blocked,
      );
    });

    await t.test("proposal list answers the open proposals", async () => {
      const page = await read<Page<Proposal>>(listArguments());
      assert.equal(page.items.length, TWO_ITEMS);
      assert.equal(page.next_cursor, null);
      proposals = proposalsByName(page);
      for (const item of page.items) {
        assert.equal(item.node_id, h.examineId);
        assert.equal(item.attempt, FIRST_ATTEMPT);
        assert.equal(item.assessment_id, assessmentId);
        assert.equal(item.approved_at, null);
        assert.equal(item.rejected_at, null);
        assert.equal(item.created_node_id, null);
        assert.equal(item.content.dependency_id, h.implementId);
        assert.deepEqual(item.content.task.verifications, TASK_VERIFICATIONS);
      }
      assert.deepEqual(
        [...proposals.keys()].sort(),
        [PROPOSAL_NAME, SECOND_PROPOSAL_NAME].sort(),
      );
    });

    await t.test("proposal list filters by attempt", async () => {
      const matching = await read<Page<Proposal>>(
        listArguments("--attempt", String(FIRST_ATTEMPT)),
      );
      assert.equal(matching.items.length, TWO_ITEMS);
      const other = await read<Page<Proposal>>(
        listArguments("--attempt", String(SECOND_ATTEMPT)),
      );
      assert.equal(other.items.length, NO_ITEMS);
    });

    await t.test(
      "a stale mission version and an invalid list refuse the decision",
      async () => {
        const ids = [...proposals.values()].map((item) => item.id);
        const stale = refused(
          await decideOver(
            human,
            ids,
            (await h.missionVersion()) + SINGLE_ITEM,
          ),
          HttpStatus.Conflict,
        );
        assert.equal(stale.error.error.code, MissionErrorCode.VersionConflict);
        const duplicate = refused(
          await decideOver(
            human,
            [ids[FIRST_INDEX]!, ids[FIRST_INDEX]!],
            await h.missionVersion(),
          ),
          HttpStatus.BadRequest,
        );
        assert.equal(duplicate.error.error.code, VALIDATION_ERROR_CODE);
        assert.ok(
          JSON.stringify(duplicate.error.error.details).includes(
            "approved_proposal_ids",
          ),
        );
      },
    );

    await t.test("a machine token is refused on both routes", async () => {
      const list = refused(
        await machine["proposal.list"]({
          params: { node_id: h.examineId },
          query: {},
          body: null,
        }),
        HttpStatus.Unauthorized,
      );
      assert.equal(list.error.error.code, UNAUTHORIZED_ERROR_CODE);
      const decide = refused(
        await decideOver(
          machine,
          [proposals.get(PROPOSAL_NAME)!.id],
          await h.missionVersion(),
        ),
        HttpStatus.Unauthorized,
      );
      assert.equal(decide.error.error.code, UNAUTHORIZED_ERROR_CODE);
      const open = await read<Page<Proposal>>(listArguments());
      for (const item of open.items) assert.equal(item.approved_at, null);
    });

    await t.test("a human token lists the proposals over HTTP", async () => {
      const page = completed(
        await human["proposal.list"]({
          params: { node_id: h.examineId },
          query: {},
          body: null,
        }),
      );
      assert.deepEqual(proposalsByName(page), proposals);
    });

    await t.test(
      "EF02.4 a decision creates each fix node, its task and the dependency of the proposer on it",
      async () => {
        const approvedIds = [
          proposals.get(SECOND_PROPOSAL_NAME)!.id,
          proposals.get(PROPOSAL_NAME)!.id,
        ];
        decided = completed(
          await decideOver(human, approvedIds, await h.missionVersion()),
        );
        assert.equal(decided.created.length, TWO_ITEMS);
        assert.deepEqual(decided.rejected_proposal_ids, []);
        assert.deepEqual(
          decided.created.map(
            (change) => change.revisions[FIRST_INDEX]!.content.name,
          ),
          [SECOND_PROPOSAL_NAME, PROPOSAL_NAME],
        );
        const listed = proposalsByName(
          await read<Page<Proposal>>(listArguments()),
        );
        for (const change of decided.created) {
          assert.equal(change.revisions.length, SINGLE_ITEM);
          const created = change.revisions[FIRST_INDEX]!;
          const fixId = created.node_id;
          assert.equal(created.tasks.length, SINGLE_ITEM);
          const taskContent = created.tasks[FIRST_INDEX]!;
          assert.ok(taskContent.id.startsWith(`${TASK_IDENTITY_PREFIX}_`));
          assert.equal(taskContent.content.name, TASK_NAME);
          const fix = await read<Node>(["mission", "node", "get", fixId]);
          assert.equal(fix.intent, Intent.Implement);
          assert.deepEqual(fix.tags, []);
          assert.deepEqual(fix.content.bindings, [h.repositoryId]);
          assert.deepEqual(
            fix.tasks.map((task) => task.id),
            [taskContent.id],
          );
          const record = listed.get(created.content.name)!;
          assert.equal(typeof record.approved_at, NUMBER_TYPE);
          assert.equal(record.rejected_at, null);
          assert.equal(record.created_node_id, fixId);
          assert.ok(
            change.added_edges.some(
              (edge) =>
                edge.dependent_id === h.examineId &&
                edge.depends_on_id === fixId,
            ),
          );
        }
      },
    );

    await t.test("the proposer reopens in a new attempt", async () => {
      const { node } = decided.proposer;
      assert.equal(node.intent, Intent.Examine);
      assert.equal(node.state, NodeState.Pending);
      assert.equal(node.attempt, SECOND_ATTEMPT);
      const queue = await read<Page<{ node_id: string }>>([
        "scheduler",
        "queue",
        "list",
        h.project.id,
      ]);
      const queued = queue.items.map((item) => item.node_id);
      for (const change of decided.created)
        assert.ok(queued.includes(change.revisions[FIRST_INDEX]!.node_id));
      assert.ok(!queued.includes(h.examineId));
    });

    await t.test("a repeated decision answers decided", async () => {
      const refusal = refused(
        await decideOver(
          human,
          [proposals.get(PROPOSAL_NAME)!.id],
          await h.missionVersion(),
        ),
        HttpStatus.Conflict,
      );
      assert.equal(refusal.error.error.code, MissionErrorCode.ProposalDecided);
      assert.deepEqual(refusal.error.error.details, {
        assessment_id: assessmentId,
      });
    });
  },
);

test(
  "Mission fix-node proposal decision through the CLI",
  { timeout: TIMEOUT },
  async (t) => {
    const names = [PROPOSAL_NAME, SECOND_PROPOSAL_NAME, THIRD_PROPOSAL_NAME];
    const h = await setup(t, names);
    const assessmentId = h.judged.assessment.id;
    const directory = temporary(t);
    let fileNumber = INITIAL_FILE_NUMBER;
    const decideArguments = (
      argument: string,
      approvedProposalIds: string[],
      version: number,
    ) => {
      const path = join(directory, `${++fileNumber}.json`);
      writePrivate(
        path,
        JSON.stringify({
          expected_mission_version: version,
          approved_proposal_ids: approvedProposalIds,
          reason: DECISION_REASON,
        }),
      );
      return ["mission", "proposal", "decide", argument, "--file", path];
    };
    const decideRefused = async (
      argument: string,
      approvedProposalIds: string[],
      version: number,
      code: string,
    ) => {
      const result = await kanthord(
        decideArguments(argument, approvedProposalIds, version),
        h.session.H,
      );
      assert.equal(result.code, FAILURE_EXIT_CODE, result.stderr);
      assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
      assert.equal(result.stdout, EMPTY_OUTPUT);
    };
    const proposals = proposalsByName(
      await h.session.read<Page<Proposal>>([
        "mission",
        "proposal",
        "list",
        h.examineId,
      ]),
    );
    const approvedIds = [
      proposals.get(PROPOSAL_NAME)!.id,
      proposals.get(THIRD_PROPOSAL_NAME)!.id,
    ];

    await t.test("the CLI refuses an invalid decision", async () => {
      await decideRefused(
        assessmentId,
        approvedIds,
        (await h.missionVersion()) + SINGLE_ITEM,
        MissionErrorCode.VersionConflict,
      );
      await decideRefused(
        assessmentId,
        [approvedIds[FIRST_INDEX]!, createIdentity("proposal")],
        await h.missionVersion(),
        MissionErrorCode.ProposalAssessmentMismatch,
      );
      await decideRefused(
        INVALID_ASSESSMENT_ARGUMENT,
        approvedIds,
        await h.missionVersion(),
        INVALID_ASSESSMENT_ID_CODE,
      );
      const after = await h.session.read<Page<Proposal>>([
        "mission",
        "proposal",
        "list",
        h.examineId,
      ]);
      assert.equal(after.items.length, names.length);
      for (const item of after.items) {
        assert.equal(item.approved_at, null);
        assert.equal(item.rejected_at, null);
      }
    });

    await t.test("the CLI decides two of three proposals", async () => {
      const result = await kanthord(
        decideArguments(assessmentId, approvedIds, await h.missionVersion()),
        h.session.H,
      );
      assert.equal(result.code, SUCCESS_EXIT_CODE, result.stderr);
      const decided = JSON.parse(result.stdout) as ProposalDecideResult & {
        idempotency_key: string;
      };
      assert.equal(decided.created.length, TWO_ITEMS);
      assert.deepEqual(
        decided.created.map(
          (change) => change.revisions[FIRST_INDEX]!.content.name,
        ),
        [PROPOSAL_NAME, THIRD_PROPOSAL_NAME],
      );
      assert.deepEqual(decided.rejected_proposal_ids, [
        proposals.get(SECOND_PROPOSAL_NAME)!.id,
      ]);
      assert.equal(decided.proposer.node.id, h.examineId);
      assert.equal(decided.proposer.node.state, NodeState.Pending);
      assert.equal(typeof decided.idempotency_key, STRING_TYPE);
      const listed = proposalsByName(
        await h.session.read<Page<Proposal>>([
          "mission",
          "proposal",
          "list",
          h.examineId,
        ]),
      );
      assert.equal(
        typeof listed.get(SECOND_PROPOSAL_NAME)!.rejected_at,
        NUMBER_TYPE,
      );
      assert.equal(listed.get(SECOND_PROPOSAL_NAME)!.approved_at, null);
    });

    await t.test("the CLI refuses a repeated decision", async () => {
      await decideRefused(
        assessmentId,
        approvedIds,
        await h.missionVersion(),
        MissionErrorCode.ProposalDecided,
      );
    });
  },
);
