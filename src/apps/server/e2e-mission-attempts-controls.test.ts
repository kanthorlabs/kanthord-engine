import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { ulid } from "ulid";
import { temporary } from "../../kernel/test-support.ts";
import { writePrivate } from "../../kernel/files.ts";
import {
  Intent,
  NodeState,
  ActorKind,
  AssessmentResult,
  ClosingEvent,
  RepositoryAction,
  ExpectedEndState,
  Resolution,
  StartPoint,
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
import {
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  COVERING_WORKER_BINDINGS,
  enableCoveringAgents,
} from "./test-support.ts";

const SUCCESS = 0;
const NO_OUTPUT = "";
const FAILURE = 1;
const INITIAL_FILE_NUMBER = 0;
const FIRST_INDEX = 0;
const INITIAL_ATTEMPT = 0;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_ITEM = 1;
const SECOND_REVISION = 2;
const COVERED_BINDING_SET_VERSION = 4;
const SECOND_ATTEMPT = 2;
const THIRD_MISSION_VERSION = 3;
const FOURTH_MISSION_VERSION = 4;
const NUMBER_TYPE = "number";
const BAD_REQUEST = 400;
const VALIDATION_FAILED = "gateway.request.validation_failed";
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
type Page<T> = { items: T[]; next_cursor: string | null };

async function setup(t: TestContext) {
  const directory = temporary(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
  });
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let fileNumber = INITIAL_FILE_NUMBER;
  const file = (body: unknown) => {
    const path = join(directory, `${++fileNumber}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[]): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
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
  assert.equal(mission.version, FIRST_REVISION);
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  await write(["repository", "credential", "create"], {
    name: "github-ssh",
    platform: "ssh",
    metadata: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_rsa",
    },
    secret: {},
  });
  await enableCoveringAgents(env);
  const binding = await write<{
    binding_set_version: number;
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      ...COVERING_WORKER_BINDINGS,
      repo: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          ssh_credential: "github-ssh",
          strategy: {
            base_branch: "main",
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
  assert.equal(binding.binding_set_version, COVERED_BINDING_SET_VERSION);
  const create = (body: unknown) =>
    write<NodeChange>(["mission", "node", "create", mission.id], body);
  const examine = await create({
    filename: "examine-1.md",
    content: { ...CONTENT, intent: Intent.Examine },
    tasks: [],
    reason: "plan",
    expected_mission_version: FIRST_REVISION,
  });
  const examineId = examine.revisions[FIRST_INDEX]!.node_id;
  const implementBody = {
    filename: "implement-1.md",
    content: {
      ...CONTENT,
      intent: Intent.Implement,
      bindings: [binding.bindings.repo!.id],
    },
    tasks: [],
    reason: "plan",
    expected_mission_version: SECOND_REVISION,
  };
  const implement = await create({
    ...implementBody,
    tasks: [{ filename: "task-1.md", content: CONTENT }],
  });
  const implementId = implement.revisions[FIRST_INDEX]!.node_id;
  const secondImplement = await create({
    ...implementBody,
    filename: "implement-2.md",
    expected_mission_version: THIRD_MISSION_VERSION,
  });
  const node = await read<Node>(["mission", "node", "get", implementId]);
  return {
    read,
    write,
    refuses,
    env,
    endpoint: fixture.endpoint,
    token: fixture.token,
    project_id: project.id,
    mission_id: mission.id,
    examineId,
    implementId,
    secondImplementId: secondImplement.revisions[FIRST_INDEX]!.node_id,
    binding_id: node.content.bindings[FIRST_INDEX]!,
    revision: node.visible_revision,
  };
}

test(
  "Mission attempts and human controls CLI acceptance",
  { timeout: JOURNEY_TIMEOUT_MS },
  async (t) => {
    const h = await setup(t);
    const act = (state: NodeState, attempt: number) => ({
      reason: "hold",
      expected_mission_version: FOURTH_MISSION_VERSION,
      expected_state: state,
      expected_attempt: attempt,
    });
    const control = (
      name: string,
      id: string,
      body: unknown,
      options: string[] = [],
    ) =>
      h.write<ControlResult>(["mission", "node", name, id, ...options], body);
    const queue = () =>
      h.read<Page<{ node_id: string }>>([
        "scheduler",
        "queue",
        "list",
        h.project_id,
      ]);
    const refuse = (
      name: string,
      id: string,
      body: unknown,
      code: string,
      options: string[] = [],
    ) => h.refuses(["mission", "node", name, id, ...options], body, code);
    const state = (answer: ControlResult, expected: NodeState) => {
      assert.ok("state" in answer.node);
      assert.equal(answer.node.state, expected);
    };
    const scenario = (name: string, run: () => Promise<void>) =>
      t.test(name, { timeout: SCENARIO_TIMEOUT_MS }, run);
    let blockedOutcome = "";
    let assessmentId = "";
    await scenario(
      "E01.2 ready opens and pins an attempt and queues evaluation",
      async () => {
        const answer = await control(
          "ready",
          h.implementId,
          act(NodeState.Available, INITIAL_ATTEMPT),
        );
        state(answer, NodeState.Waiting);
        assert.equal(answer.node.attempt, FIRST_ATTEMPT);
        assert.equal(answer.attempt?.attempt, FIRST_ATTEMPT);
        assert.equal(answer.attempt?.node_revision, h.revision);
        assert.equal(answer.attempt?.opened_by.kind, ActorKind.Human);
        assert.equal(answer.outcome, null);
        assert.ok(
          (await queue()).items.some((item) => item.node_id === h.implementId),
        );
        assert.equal(
          (await h.read<Mission>(["mission", "get", h.project_id])).version,
          FOURTH_MISSION_VERSION,
        );
      },
    );
    await scenario(
      "E01.3 pause removes the job and keeps the attempt open",
      async () => {
        const answer = await control(
          "pause",
          h.implementId,
          act(NodeState.Waiting, FIRST_ATTEMPT),
        );
        state(answer, NodeState.Paused);
        assert.equal(answer.attempt?.closed_at, null);
        assert.ok(
          !(await queue()).items.some((item) => item.node_id === h.implementId),
        );
      },
    );
    await scenario("E01.4 resume requeues Waiting", async () => {
      state(
        await control("resume", h.implementId, {
          ...act(NodeState.Paused, FIRST_ATTEMPT),
          target: NodeState.Waiting,
        }),
        NodeState.Waiting,
      );
      assert.ok(
        (await queue()).items.some((item) => item.node_id === h.implementId),
      );
    });
    await scenario(
      "E01.5 block closes and exposes blocked context",
      async () => {
        await control(
          "pause",
          h.implementId,
          act(NodeState.Waiting, FIRST_ATTEMPT),
        );
        const answer = await control(
          "block",
          h.implementId,
          act(NodeState.Paused, FIRST_ATTEMPT),
        );
        state(answer, NodeState.Blocked);
        assert.equal(answer.outcome?.result, AssessmentResult.Undetermined);
        assert.equal(answer.outcome?.closing_event, ClosingEvent.HumanBlock);
        assert.equal(answer.outcome?.attempt, FIRST_ATTEMPT);
        assert.equal(typeof answer.attempt?.closed_at, NUMBER_TYPE);
        blockedOutcome = answer.outcome!.id;
        const node = await h.read<Node>([
          "mission",
          "node",
          "get",
          h.implementId,
        ]);
        assert.equal(node.blocked_context?.outcome.id, blockedOutcome);
        assert.deepEqual(node.blocked_context?.requests, []);
      },
    );
    await scenario("E01.6 unblock opens exactly the next attempt", async () => {
      const unblock = {
        blocked_attempt: FIRST_ATTEMPT,
        expected_revision: h.revision,
        expected_mission_version: FOURTH_MISSION_VERSION,
      };
      const refused = await fetch(
        `${h.endpoint}/api/mission/node/${h.implementId}/unblock`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${h.token}`,
            "content-type": "application/json",
            "Idempotency-Key": ulid(),
          },
          body: JSON.stringify({ ...unblock, start_point: "fresh" }),
        },
      );
      assert.equal(refused.status, BAD_REQUEST);
      assert.equal(
        ((await refused.json()) as { error: { code: string } }).error.code,
        VALIDATION_FAILED,
      );
      const blocked = await h.read<Node>([
        "mission",
        "node",
        "get",
        h.implementId,
      ]);
      assert.equal(blocked.state, NodeState.Blocked);
      assert.equal(blocked.attempt, FIRST_ATTEMPT);
      const answer = await control("unblock", h.implementId, unblock);
      state(answer, NodeState.Available);
      assert.equal(answer.attempt?.attempt, SECOND_ATTEMPT);
      assert.equal(answer.attempt?.start_point, StartPoint.NodeBranch);
      assert.equal(answer.attempt?.opened_by.kind, ActorKind.Human);
      assert.equal(answer.outcome, null);
    });
    await scenario("E01.7 attempt reads retain closed history", async () => {
      const list = await h.read<Page<Attempt>>([
        "mission",
        "attempt",
        "list",
        h.implementId,
      ]);
      assert.deepEqual(
        list.items.map((item) => item.attempt),
        [SECOND_ATTEMPT, FIRST_ATTEMPT],
      );
      assert.equal(list.next_cursor, null);
      const closed = await h.read<Attempt>([
        "mission",
        "attempt",
        "get",
        h.implementId,
        String(FIRST_ATTEMPT),
      ]);
      assert.equal(typeof closed.closed_at, NUMBER_TYPE);
      assert.deepEqual(closed.outcome_ids, [blockedOutcome]);
      assert.deepEqual(
        list.items.map((item) => item.start_point),
        [StartPoint.NodeBranch, StartPoint.BaseBranch],
      );
      assert.equal(closed.start_point, StartPoint.BaseBranch);
    });
    await scenario(
      "E01.8 attempt reads frozen repository requirements",
      async () => {
        const attempt = await h.read<Attempt>([
          "mission",
          "attempt",
          "get",
          h.implementId,
          String(SECOND_ATTEMPT),
        ]);
        assert.deepEqual(attempt.required_external_actions, [
          {
            key: ACTION_KEY,
            binding_id: h.binding_id,
            action: RepositoryAction.PullRequest,
            expected_end_state: ExpectedEndState.PullRequestMerged,
            follows: null,
            configuration: { base_branch: "main", landing: "human" },
          },
        ]);
        assert.equal(attempt.closed_at, null);
      },
    );
    await scenario("E01.9 external actions are unrequested", async () => {
      const page = await h.read<Page<ExternalAction>>([
        "mission",
        "external-action",
        "list",
        h.implementId,
        "--attempt",
        String(SECOND_ATTEMPT),
      ]);
      assert.equal(page.items.length, SINGLE_ITEM);
      assert.equal(page.items[FIRST_INDEX]!.resolution, Resolution.Unrequested);
      assert.equal(page.items[FIRST_INDEX]!.requested, false);
      assert.equal(page.items[FIRST_INDEX]!.request_evidence_id, null);
      const action = await h.read<ExternalAction>([
        "mission",
        "external-action",
        "get",
        h.implementId,
        String(SECOND_ATTEMPT),
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
          h.implementId,
        ]);
        assert.equal(page.items.length, SINGLE_ITEM);
        const assessment = page.items[FIRST_INDEX]!;
        assessmentId = assessment.id;
        assert.equal(assessment.actor.kind, ActorKind.Human);
        assert.equal(assessment.result, AssessmentResult.Undetermined);
        assert.equal(assessment.execution_id, null);
        assert.equal(assessment.tested_input, null);
        assert.equal(assessment.currency, null);
        assert.equal(assessment.worker_version, null);
        assert.equal(assessment.attempt, FIRST_ATTEMPT);
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
        h.implementId,
        "--attempt",
        String(FIRST_ATTEMPT),
      ]);
      assert.equal(page.items.length, SINGLE_ITEM);
      assert.equal(
        (
          await h.read<Outcome>([
            "mission",
            "outcome",
            "get",
            page.items[FIRST_INDEX]!.id,
          ])
        ).assessment_id,
        assessmentId,
      );
    });
    await scenario(
      "E01.12 success override publishes landed commit evidence",
      async () => {
        const answer = await control(
          "override",
          h.implementId,
          {
            ...act(NodeState.Available, SECOND_ATTEMPT),
            landed_commit: {
              kind: "repository",
              binding_id: h.binding_id,
              commit: COMMIT,
            },
          },
          ["--result", "success"],
        );
        state(answer, NodeState.Completed);
        assert.equal(answer.outcome?.result, AssessmentResult.Success);
        assert.equal(
          answer.outcome?.closing_event,
          ClosingEvent.SuccessOverride,
        );
        assert.equal(answer.outcome?.evidence_ids.length, SINGLE_ITEM);
        assert.equal(typeof answer.attempt?.closed_at, NUMBER_TYPE);
      },
    );
    await scenario("E01.13 discard preserves attempt zero", async () => {
      const answer = await control(
        "discard",
        h.secondImplementId,
        act(NodeState.Available, INITIAL_ATTEMPT),
      );
      state(answer, NodeState.Discarded);
      assert.equal(answer.attempt, null);
      assert.equal(answer.outcome?.attempt, INITIAL_ATTEMPT);
      assert.equal(answer.outcome?.closing_event, ClosingEvent.HumanDiscard);
    });
    await scenario(
      "E01.14 an examine node with no dependency admits readiness",
      async () => {
        assert.ok(
          (await queue()).items.some((item) => item.node_id === h.examineId),
        );
        const answer = await control(
          "ready",
          h.examineId,
          act(NodeState.Available, INITIAL_ATTEMPT),
        );
        state(answer, NodeState.Waiting);
        assert.equal(answer.attempt?.attempt, FIRST_ATTEMPT);
      },
    );
    await scenario("E01.15 block requires pause", async () => {
      await refuse(
        "block",
        h.examineId,
        act(NodeState.Waiting, FIRST_ATTEMPT),
        "mission.node.control_refused",
      );
    });
    await scenario("E01.17 terminal nodes refuse controls", async () => {
      await refuse(
        "pause",
        h.implementId,
        act(NodeState.Completed, SECOND_ATTEMPT),
        "mission.node.terminal",
      );
    });
    await scenario("E01.18 attempt precondition is enforced", async () => {
      await refuse(
        "pause",
        h.examineId,
        act(NodeState.Waiting, INITIAL_ATTEMPT),
        "mission.node.state_conflict",
      );
    });
    await scenario(
      "E01.19 mission version precondition is enforced",
      async () => {
        await refuse(
          "pause",
          h.examineId,
          {
            ...act(NodeState.Waiting, FIRST_ATTEMPT),
            expected_mission_version: THIRD_MISSION_VERSION,
          },
          "mission.version.conflict",
        );
      },
    );
    await scenario(
      "E01.20 landed commit must match pinned repository",
      async () => {
        await refuse(
          "override",
          h.examineId,
          {
            ...act(NodeState.Waiting, FIRST_ATTEMPT),
            landed_commit: {
              kind: "repository",
              binding_id: BINDING_ID,
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
          act(NodeState.Waiting, FIRST_ATTEMPT),
          "cli.mission.node.pause.invalid_node_id",
        );
        await refuse(
          "override",
          h.examineId,
          act(NodeState.Waiting, FIRST_ATTEMPT),
          "cli.mission.node.override.invalid_result",
          ["--result", "failure"],
        );
        await refuse(
          "override",
          h.examineId,
          { ...act(NodeState.Waiting, FIRST_ATTEMPT), result: "success" },
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
          ["attempt", "get", h.implementId, String(INITIAL_ATTEMPT)],
          "cli.mission.attempt.get.invalid_attempt",
        );
        await readRefusal(
          [
            "external-action",
            "get",
            h.implementId,
            String(SECOND_ATTEMPT),
            "repo.push",
          ],
          "cli.mission.external_action.get.invalid_action_key",
        );
      },
    );
    await scenario("E01.23 absent attempt answers not found", async () => {
      await readRefusal(
        ["attempt", "get", h.implementId, "9"],
        "mission.record.not_found",
      );
    });
  },
);
