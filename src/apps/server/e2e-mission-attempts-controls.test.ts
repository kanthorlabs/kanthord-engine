import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { temporary } from "../../kernel/test-support.ts";
import { writePrivate } from "../../kernel/files.ts";
import {
  NodeKind,
  EdgeKind,
  NodeState,
  ActorKind,
  AssessmentResult,
  ClosingEvent,
  RepositoryAction,
  ExpectedEndState,
  Resolution,
  type ControlResult,
  type Node,
  type NodeChange,
  type Mission,
  type Attempt,
  type ExternalAction,
  type Assessment,
  type Outcome,
} from "../../mission/contract.ts";
import { kanthord, environment } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const SUCCESS = 0;
const EMPTY = "";
const FAILURE = 1;
const ZERO = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const VERSION = 5;
const NUMBER_TYPE = "number";
const JOURNEY_TIMEOUT_MS = 300000;
const SCENARIO_TIMEOUT_MS = 30000;
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const COMMIT = "a".repeat(40);
const ACTION_KEY = "repo.pull_request";
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[]; nextCursor: string | null };

async function setup(t: TestContext) {
  const directory = temporary(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshHostname: async () => "github.com",
    },
  });
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let fileNumber = ZERO;
  const file = (body: unknown) => {
    const path = join(directory, `${++fileNumber}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[]): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, EMPTY);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown) =>
    read<T>([...args, "--file", file(body)]);
  const refuses = async (args: string[], body: unknown, code: string) => {
    const result = await kanthord([...args, "--file", file(body)], env);
    assert.equal(result.code, FAILURE, result.stderr);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  };
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "controls",
  ]);
  const mission = await read<Mission>(["mission", "get", project.id]);
  assert.equal(mission.version, ONE);
  await write(["credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  const binding = await write<{
    bindingSetVersion: number;
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: ONE,
    bindings: {
      repo: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          strategy: {
            baseBranch: "main",
            action: {
              name: "pull_request",
              follows: { type: "assessment_passed" },
            },
          },
          credential: "github",
        },
      },
    },
  });
  assert.equal(binding.bindingSetVersion, TWO);
  const create = (body: unknown) =>
    write<NodeChange>(["mission", "node", "create", mission.id], body);
  const initiative = await create({
    filename: "initiative-1.md",
    kind: NodeKind.Initiative,
    content: CONTENT,
    reason: "plan",
    expectedMissionVersion: ONE,
  });
  const initiativeId = initiative.revisions[ZERO]!.nodeId;
  const objectiveBody = {
    filename: "objective-1.md",
    kind: NodeKind.Objective,
    content: { ...CONTENT, bindings: [binding.bindings.repo!.id] },
    reason: "plan",
    parentId: initiativeId,
    expectedParentRevision: ONE,
    expectedMissionVersion: TWO,
  };
  const objective = await create(objectiveBody);
  const objectiveId = objective.revisions[ZERO]!.nodeId;
  const task = await create({
    filename: "task-1.md",
    kind: NodeKind.Task,
    content: CONTENT,
    reason: "plan",
    parentId: objectiveId,
    expectedParentRevision: ONE,
    expectedMissionVersion: THREE,
  });
  const taskId = task.addedEdges.find(
    (edge) => edge.kind === EdgeKind.Containment,
  )!.childId;
  const secondObjective = await create({
    ...objectiveBody,
    filename: "objective-2.md",
    expectedMissionVersion: FOUR,
  });
  const node = await read<Node>(["mission", "node", "get", objectiveId]);
  return {
    read,
    write,
    refuses,
    env,
    projectId: project.id,
    missionId: mission.id,
    initiativeId,
    objectiveId,
    taskId,
    secondObjectiveId: secondObjective.revisions[ZERO]!.nodeId,
    bindingId: node.content.bindings[ZERO]!,
    revision: node.visibleRevision,
  };
}

test(
  "Mission attempts and human controls CLI acceptance",
  { timeout: JOURNEY_TIMEOUT_MS },
  async (t) => {
    const h = await setup(t);
    const act = (state: NodeState, attempt: number) => ({
      reason: "hold",
      expectedMissionVersion: VERSION,
      expectedState: state,
      expectedAttempt: attempt,
    });
    const control = (
      name: string,
      id: string,
      body: unknown,
      options: string[] = [],
    ) =>
      h.write<ControlResult>(["mission", "node", name, id, ...options], body);
    const queue = () =>
      h.read<Page<{ nodeId: string }>>([
        "scheduler",
        "queue",
        "list",
        h.projectId,
      ]);
    const refuse = (
      name: string,
      id: string,
      body: unknown,
      code: string,
      options: string[] = [],
    ) => h.refuses(["mission", "node", name, id, ...options], body, code);
    const state = (answer: ControlResult, expected: NodeState) => {
      assert.notEqual(answer.node.kind, NodeKind.Task);
      assert.ok("state" in answer.node);
      assert.equal(answer.node.state, expected);
    };
    const scenario = (name: string, run: () => Promise<void>) =>
      t.test(name, { timeout: SCENARIO_TIMEOUT_MS }, run);
    let blockedOutcome = "";
    let assessmentId = "";
    await scenario(
      "E01.1 initiative ready refuses nonterminal children",
      async () => {
        await refuse(
          "ready",
          h.initiativeId,
          act(NodeState.Available, ZERO),
          "mission.node.not_ready",
        );
      },
    );
    await scenario(
      "E01.2 ready opens and pins an attempt and queues evaluation",
      async () => {
        const answer = await control(
          "ready",
          h.objectiveId,
          act(NodeState.Available, ZERO),
        );
        state(answer, NodeState.Waiting);
        assert.ok(answer.node.kind !== NodeKind.Task);
        assert.equal(answer.node.attempt, ONE);
        assert.equal(answer.attempt?.attempt, ONE);
        assert.equal(answer.attempt?.nodeRevision, h.revision);
        assert.equal(answer.attempt?.openedBy.kind, ActorKind.Human);
        assert.equal(answer.outcome, null);
        assert.ok(
          (await queue()).items.some((item) => item.nodeId === h.objectiveId),
        );
        assert.equal(
          (await h.read<Mission>(["mission", "get", h.projectId])).version,
          VERSION,
        );
      },
    );
    await scenario(
      "E01.3 pause removes the job and keeps the attempt open",
      async () => {
        const answer = await control(
          "pause",
          h.objectiveId,
          act(NodeState.Waiting, ONE),
        );
        state(answer, NodeState.Paused);
        assert.equal(answer.attempt?.closedAt, null);
        assert.ok(
          !(await queue()).items.some((item) => item.nodeId === h.objectiveId),
        );
      },
    );
    await scenario("E01.4 resume requeues Waiting", async () => {
      state(
        await control("resume", h.objectiveId, {
          ...act(NodeState.Paused, ONE),
          target: NodeState.Waiting,
        }),
        NodeState.Waiting,
      );
      assert.ok(
        (await queue()).items.some((item) => item.nodeId === h.objectiveId),
      );
    });
    await scenario(
      "E01.5 block closes and exposes blocked context",
      async () => {
        await control("pause", h.objectiveId, act(NodeState.Waiting, ONE));
        const answer = await control(
          "block",
          h.objectiveId,
          act(NodeState.Paused, ONE),
        );
        state(answer, NodeState.Blocked);
        assert.equal(answer.outcome?.result, AssessmentResult.Undetermined);
        assert.equal(answer.outcome?.closingEvent, ClosingEvent.HumanBlock);
        assert.equal(answer.outcome?.attempt, ONE);
        assert.equal(typeof answer.attempt?.closedAt, NUMBER_TYPE);
        blockedOutcome = answer.outcome!.id;
        const node = await h.read<Node>([
          "mission",
          "node",
          "get",
          h.objectiveId,
        ]);
        assert.ok(node.kind !== NodeKind.Task);
        assert.equal(node.blockedContext?.outcome.id, blockedOutcome);
        assert.deepEqual(node.blockedContext?.requests, []);
      },
    );
    await scenario("E01.6 unblock opens exactly the next attempt", async () => {
      const answer = await control("unblock", h.objectiveId, {
        blockedAttempt: ONE,
        expectedRevision: h.revision,
        expectedMissionVersion: VERSION,
      });
      state(answer, NodeState.Available);
      assert.equal(answer.attempt?.attempt, TWO);
      assert.equal(answer.attempt?.openedBy.kind, ActorKind.Human);
      assert.equal(answer.outcome, null);
    });
    await scenario("E01.7 attempt reads retain closed history", async () => {
      const list = await h.read<Page<Attempt>>([
        "mission",
        "attempt",
        "list",
        h.objectiveId,
      ]);
      assert.deepEqual(
        list.items.map((item) => item.attempt),
        [TWO, ONE],
      );
      assert.equal(list.nextCursor, null);
      const closed = await h.read<Attempt>([
        "mission",
        "attempt",
        "get",
        h.objectiveId,
        String(ONE),
      ]);
      assert.equal(typeof closed.closedAt, NUMBER_TYPE);
      assert.deepEqual(closed.outcomeIds, [blockedOutcome]);
    });
    await scenario(
      "E01.8 attempt reads frozen repository requirements",
      async () => {
        const attempt = await h.read<Attempt>([
          "mission",
          "attempt",
          "get",
          h.objectiveId,
          String(TWO),
        ]);
        assert.deepEqual(attempt.requiredExternalActions, [
          {
            key: ACTION_KEY,
            bindingId: h.bindingId,
            action: RepositoryAction.PullRequest,
            expectedEndState: ExpectedEndState.PullRequestMerged,
            follows: null,
            configuration: { baseBranch: "main" },
          },
        ]);
        assert.equal(attempt.closedAt, null);
      },
    );
    await scenario("E01.9 external actions are unrequested", async () => {
      const page = await h.read<Page<ExternalAction>>([
        "mission",
        "external-action",
        "list",
        h.objectiveId,
        "--attempt",
        String(TWO),
      ]);
      assert.equal(page.items.length, ONE);
      assert.equal(page.items[ZERO]!.resolution, Resolution.Unrequested);
      assert.equal(page.items[ZERO]!.requested, false);
      assert.equal(page.items[ZERO]!.requestEvidenceId, null);
      const action = await h.read<ExternalAction>([
        "mission",
        "external-action",
        "get",
        h.objectiveId,
        String(TWO),
        ACTION_KEY,
      ]);
      assert.equal(action.action.key, ACTION_KEY);
    });
    await scenario(
      "E01.10 human assessment fields are read-only records",
      async () => {
        const page = await h.read<Page<Assessment>>([
          "mission",
          "assessment",
          "list",
          h.objectiveId,
        ]);
        assert.equal(page.items.length, ONE);
        const assessment = page.items[ZERO]!;
        assessmentId = assessment.id;
        assert.equal(assessment.actor.kind, ActorKind.Human);
        assert.equal(assessment.result, AssessmentResult.Undetermined);
        assert.equal(assessment.executionId, null);
        assert.equal(assessment.testedInput, null);
        assert.equal(assessment.currency, null);
        assert.equal(assessment.workerVersion, null);
        assert.equal(assessment.attempt, ONE);
        assert.equal(
          (
            await h.read<Assessment>([
              "mission",
              "assessment",
              "get",
              assessmentId,
            ])
          ).id,
          assessmentId,
        );
      },
    );
    await scenario("E01.11 outcomes name their assessment", async () => {
      const page = await h.read<Page<Outcome>>([
        "mission",
        "outcome",
        "list",
        h.objectiveId,
        "--attempt",
        String(ONE),
      ]);
      assert.equal(page.items.length, ONE);
      assert.equal(
        (
          await h.read<Outcome>([
            "mission",
            "outcome",
            "get",
            page.items[ZERO]!.id,
          ])
        ).assessmentId,
        assessmentId,
      );
    });
    await scenario(
      "E01.12 success override publishes landed commit evidence",
      async () => {
        const answer = await control(
          "override",
          h.objectiveId,
          {
            ...act(NodeState.Available, TWO),
            landedCommit: {
              kind: "repository",
              bindingId: h.bindingId,
              commit: COMMIT,
            },
          },
          ["--result", "success"],
        );
        state(answer, NodeState.Completed);
        assert.equal(answer.outcome?.result, AssessmentResult.Success);
        assert.equal(
          answer.outcome?.closingEvent,
          ClosingEvent.SuccessOverride,
        );
        assert.equal(answer.outcome?.evidenceIds.length, ONE);
        assert.equal(typeof answer.attempt?.closedAt, NUMBER_TYPE);
      },
    );
    await scenario("E01.13 discard preserves attempt zero", async () => {
      const answer = await control(
        "discard",
        h.secondObjectiveId,
        act(NodeState.Available, ZERO),
      );
      state(answer, NodeState.Discarded);
      assert.equal(answer.attempt, null);
      assert.equal(answer.outcome?.attempt, ZERO);
      assert.equal(answer.outcome?.closingEvent, ClosingEvent.HumanDiscard);
    });
    await scenario(
      "E01.14 terminal objectives admit initiative readiness",
      async () => {
        assert.ok(
          (await queue()).items.some((item) => item.nodeId === h.initiativeId),
        );
        const answer = await control(
          "ready",
          h.initiativeId,
          act(NodeState.Available, ZERO),
        );
        state(answer, NodeState.Waiting);
        assert.equal(answer.attempt?.attempt, ONE);
      },
    );
    await scenario("E01.15 block requires pause", async () => {
      await refuse(
        "block",
        h.initiativeId,
        act(NodeState.Waiting, ONE),
        "mission.node.control_refused",
      );
    });
    await scenario("E01.16 tasks have no controls", async () => {
      await refuse(
        "pause",
        h.taskId,
        act(NodeState.Waiting, ONE),
        "mission.node.control_task",
      );
    });
    await scenario("E01.17 terminal nodes refuse controls", async () => {
      await refuse(
        "pause",
        h.objectiveId,
        act(NodeState.Completed, TWO),
        "mission.node.terminal",
      );
    });
    await scenario("E01.18 attempt precondition is enforced", async () => {
      await refuse(
        "pause",
        h.initiativeId,
        act(NodeState.Waiting, ZERO),
        "mission.node.state_conflict",
      );
    });
    await scenario(
      "E01.19 mission version precondition is enforced",
      async () => {
        await refuse(
          "pause",
          h.initiativeId,
          { ...act(NodeState.Waiting, ONE), expectedMissionVersion: FOUR },
          "mission.version.conflict",
        );
      },
    );
    await scenario(
      "E01.20 landed commit must match pinned repository",
      async () => {
        await refuse(
          "override",
          h.initiativeId,
          {
            ...act(NodeState.Waiting, ONE),
            landedCommit: {
              kind: "repository",
              bindingId: BINDING_ID,
              commit: COMMIT,
            },
          },
          "mission.evidence.binding_mismatch",
          ["--result", "success"],
        );
      },
    );
    await scenario(
      "E01.21 CLI validates identity, success-only result and strict file",
      async () => {
        await refuse(
          "pause",
          "invalid",
          act(NodeState.Waiting, ONE),
          "cli.mission.node.pause.invalid_node_id",
        );
        await refuse(
          "override",
          h.initiativeId,
          act(NodeState.Waiting, ONE),
          "cli.mission.node.override.invalid_result",
          ["--result", "failure"],
        );
        await refuse(
          "override",
          h.initiativeId,
          { ...act(NodeState.Waiting, ONE), result: "success" },
          "cli.file.schema_invalid",
          ["--result", "success"],
        );
      },
    );
    const readRefusal = async (args: string[], code: string) => {
      const result = await kanthord(["mission", ...args], h.env);
      assert.equal(result.code, FAILURE);
      assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    };
    await scenario(
      "E01.22 record CLI validates attempt and action key",
      async () => {
        await readRefusal(
          ["attempt", "get", h.objectiveId, String(ZERO)],
          "cli.mission.attempt.get.invalid_attempt",
        );
        await readRefusal(
          ["external-action", "get", h.objectiveId, String(TWO), "repo.push"],
          "cli.mission.external_action.get.invalid_action_key",
        );
      },
    );
    await scenario("E01.23 absent attempt answers not found", async () => {
      await readRefusal(
        ["attempt", "get", h.objectiveId, "9"],
        "mission.record.not_found",
      );
    });
  },
);
