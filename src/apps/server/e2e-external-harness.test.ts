import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayOperations } from "../../gateway/contract.ts";
import {
  NodeState,
  type Evidence,
  type Assessment,
  type Outcome,
} from "../../mission/contract.ts";
import { ClaimState, type ExecutionRecord } from "../../scheduler/contract.ts";
import { InstanceActivity } from "../../worker/contract.ts";
import { generateMachineToken } from "./cli-support.ts";
import {
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  outboundHosts,
} from "./test-support.ts";
import {
  journeyClient,
  createJourneyNode,
  JOURNEY_TIMEOUT_MS,
  GITHUB_KEY,
  REPOSITORY_ADDRESS,
} from "./journey-support.ts";

const INITIAL_BINDING_VERSION = 1;
const SINGLE_INSTANCE = 1;
const FIRST_ATTEMPT = 1;
const EXPECTED_EXECUTION_COUNT = 4;
const WORKER = "claude@1";
const CLAIMED = "claimed";
const HEALTHY = "healthy";
const SUCCESS = "success";
const EXECUTION_ACTOR = "execution";
const ASSESSMENT_PASSED = "assessment-passed";
const UNOBSERVED_REQUEST_COUNT = 0;
type Submitted = { evidence: Evidence };
type Assessed = {
  assessment: Assessment;
  outcome: Outcome;
  node: { state: string };
};
type Claim = { kind: string; execution: ExecutionRecord };

test(
  "EX10.1–11 external harness completes objective and initiative through CLI",
  { timeout: JOURNEY_TIMEOUT_MS },
  async (t) => {
    const hosts = outboundHosts(t);
    const fixture = await gatewayFixture(t, {
      repositoryConnector: {
        gitLsRemote: async () => {},
        resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
      },
      inventoryOverrides: { llm: () => [], repository: () => [] },
    });
    const cli = journeyClient(t, fixture.endpoint, fixture.token);
    await cli.write(["repository", "credential", "create"], {
      name: "github",
      platform: "github",
      metadata: null,
      secret: { key: GITHUB_KEY },
    });
    await cli.write(["repository", "credential", "create"], {
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
    const project = await cli.read<{ id: string }>([
      "project",
      "create",
      "--name",
      "harness",
    ]);
    const bindings = await cli.write<{
      bindings: Record<string, { id: string; resource_identity: string }>;
    }>(["project", "binding", "apply", project.id], {
      version: INITIAL_BINDING_VERSION,
      bindings: {
        repo: {
          kind: "repository",
          config: {
            available: true,
            platform: "github",
            address: REPOSITORY_ADDRESS,
            ssh_credential: "github-ssh",
            strategy: { base_branch: "main" },
            credential: "github",
          },
        },
        harness: {
          kind: "worker",
          config: { worker: WORKER, instance_count: SINGLE_INSTANCE },
        },
      },
    });
    const initiative = await createJourneyNode(
      cli,
      project.id,
      "initiative-1.md",
      "initiative",
      [],
    );
    const objective = await createJourneyNode(
      cli,
      project.id,
      "objective-a.md",
      "objective",
      [bindings.bindings.repo!.id],
      initiative,
    );
    const issue = (name: string) =>
      generateMachineToken({
        env: cli.human,
        masterKey: fixture.config.master_key,
        projectId: project.id,
        bindingName: "harness",
        name,
      });
    const auth = issue("test_harness_a");
    const other = issue("test_harness_b");
    cli.secrets.push(
      auth.token,
      other.token,
      auth.client_secret,
      other.client_secret,
    );
    const registration = await cli.read<{
      runtime_identity: string;
      resource_identity: string;
      worker_name: string;
      idempotency_key: string;
    }>(["worker", "register"], auth.token);
    const runtime = registration.runtime_identity;
    const resource = bindings.bindings.harness!.resource_identity;
    await t.test("EX10.1 registration and capacity", async () => {
      assert.match(runtime, /^worker_instance_/);
      assert.equal(registration.resource_identity, resource);
      assert.equal(registration.worker_name, WORKER);
      assert.match(registration.idempotency_key, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      await cli.refuses(
        ["worker", "register"],
        other.token,
        "worker.instance.slot_unavailable",
      );
    });
    async function health() {
      const response = await fixture.request(
        gatewayOperations.healthcheck.path,
        { headers: { authorization: `Bearer ${fixture.token}` } },
      );
      assert.ok(response.ok);
      return gatewayOperations.healthcheck.output.parse(await response.json());
    }
    await t.test("EX10.2 heartbeat and registration inventory", async () => {
      assert.equal(await cli.read(["worker", "heartbeat"], auth.token), null);
      const report = await health();
      assert.deepEqual(report.services.worker.projects.harness, {
        [`harness/${runtime}`]: {
          status: HEALTHY,
          capability: "liveness of a registration",
        },
      });
      assert.deepEqual(report.services.worker.global, {});
      assert.equal(
        report.services.project.projects.harness!.repo!.status,
        HEALTHY,
      );
    });
    const pullFile = cli.file({
      resource_identity: resource,
      runtime_identity: runtime,
    });
    const pull = () =>
      cli.read<Claim>(
        ["scheduler", "work", "pull", "--file", pullFile],
        auth.token,
      );
    const node = (id: string) =>
      cli.read<{ state: string }>(["mission", "node", "get", id]);
    const ctx = (execution: ExecutionRecord) => ({
      execution_id: execution.execution_id,
      attempt: execution.attempt,
      node_revision: execution.pinned_revision,
    });
    const repoAt = (character: string) => ({
      kind: "repository",
      binding_id: bindings.bindings.repo!.id,
      commit: character.repeat(40),
    });
    const release = (execution: ExecutionRecord) =>
      cli.write<{ ended_at: number }>(
        ["scheduler", "execution", "release", execution.execution_id],
        { further_work: false },
        auth.token,
      );
    const first = await pull();
    await t.test("EX10.3 steps claim and instance activity", async () => {
      assert.equal(first.kind, CLAIMED);
      assert.equal(first.execution.node_id, objective);
      assert.equal(first.execution.attempt, FIRST_ATTEMPT);
      assert.equal(first.execution.claimant.runtime_identity, runtime);
      const instance = await cli.read<{
        activity: string;
        execution_id: string;
      }>(["worker", "instance", "get", runtime]);
      assert.equal(instance.activity, InstanceActivity.Executing);
      assert.equal(instance.execution_id, first.execution.execution_id);
    });
    await t.test(
      "EX10.4 external harness receives no inference credential",
      async () => {
        await cli.refuses(
          ["worker", "handover", first.execution.execution_id],
          auth.token,
          "worker.authorization.refused",
        );
        const execution = await cli.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          first.execution.execution_id,
        ]);
        assert.deepEqual(execution.credentials, []);
      },
    );
    let work!: Evidence;
    await t.test(
      "EX10.5 pinned revision and steps evidence release",
      async () => {
        const pinned = await cli.read<{
          content: { verifications: string[] };
          tasks: unknown[];
        }>(
          [
            "mission",
            "execution",
            "pinned-revision",
            "get",
            first.execution.execution_id,
          ],
          auth.token,
        );
        assert.deepEqual(pinned.content.verifications, ["test -f hello.txt"]);
        assert.deepEqual(pinned.tasks, []);
        work = (
          await cli.write<Submitted>(
            ["mission", "evidence", "submit", objective],
            {
              ...ctx(first.execution),
              subject: "head commit",
              assets: [{ kind: "repository", address: repoAt("a") }],
            },
            auth.token,
          )
        ).evidence;
        assert.equal(work.provenance.kind, EXECUTION_ACTOR);
        assert.ok("execution_id" in work.provenance);
        assert.equal(
          work.provenance.execution_id,
          first.execution.execution_id,
        );
        assert.ok(Number.isFinite((await release(first.execution)).ended_at));
        assert.equal((await node(objective)).state, NodeState.Waiting);
      },
    );
    const second = await pull();
    await t.test("EX10.6 evaluation claim", async () => {
      assert.equal(second.execution.node_id, objective);
      assert.equal(second.execution.attempt, FIRST_ATTEMPT);
      const claim = await cli.read<{ claim_state: string }>(
        ["scheduler", "claim", "get", second.execution.execution_id],
        auth.token,
      );
      assert.equal(claim.claim_state, ClaimState.Running);
      assert.equal((await node(objective)).state, NodeState.Evaluating);
    });
    async function verification(
      execution: ExecutionRecord,
      input: unknown,
      command: string,
    ) {
      return (
        await cli.write<Submitted>(
          ["mission", "evidence", "submit", execution.node_id],
          {
            ...ctx(execution),
            subject: "verification run",
            assets: [
              {
                kind: "produced",
                content: {
                  media_type: "text/plain",
                  encoding: "base64",
                  data: "b2s=",
                },
              },
            ],
            verification: {
              tested_input: input,
              results: [
                { command, exit_code: 0, signal: null, timed_out: false },
              ],
            },
          },
          auth.token,
        )
      ).evidence;
    }
    let outcomeA!: string;
    await t.test("EX10.7 assessment closes objective and claim", async () => {
      const run = await verification(
        second.execution,
        repoAt("a"),
        "test -f hello.txt",
      );
      const assessed = await cli.write<Assessed>(
        ["mission", "assessment", "submit", objective],
        {
          ...ctx(second.execution),
          evidence_ids: [run.id, work.id],
          child_outcome_ids: [],
          result: SUCCESS,
          rationale: "hello.txt exists",
          tested_input: repoAt("a"),
        },
        auth.token,
      );
      assert.equal(assessed.assessment.actor.kind, EXECUTION_ACTOR);
      assert.equal(assessed.assessment.worker_version, WORKER);
      assert.equal(assessed.node.state, NodeState.Completed);
      assert.equal(assessed.outcome.result, SUCCESS);
      assert.equal(assessed.outcome.closing_event, ASSESSMENT_PASSED);
      outcomeA = assessed.outcome.id;
      const claim = await cli.read<{ claim_state: string }>(
        ["scheduler", "claim", "get", second.execution.execution_id],
        auth.token,
      );
      assert.equal(claim.claim_state, ClaimState.Finished);
    });
    const third = await pull();
    let report!: Evidence;
    await t.test(
      "EX10.8 initiative report follows terminal objective",
      async () => {
        assert.equal(third.execution.node_id, initiative);
        const children = await cli.read<{
          items: { id: string; state: string }[];
        }>(
          [
            "mission",
            "execution",
            "objective",
            "list",
            third.execution.execution_id,
          ],
          auth.token,
        );
        assert.deepEqual(
          children.items.map(({ id }) => id),
          [objective],
        );
        assert.equal(children.items[0]!.state, NodeState.Completed);
        const outcomes = await cli.read<{ items: { id: string }[] }>(
          [
            "mission",
            "execution",
            "objective",
            "outcome",
            "list",
            third.execution.execution_id,
          ],
          auth.token,
        );
        assert.deepEqual(
          outcomes.items.map(({ id }) => id),
          [outcomeA],
        );
        report = (
          await cli.write<Submitted>(
            ["mission", "evidence", "submit", initiative],
            {
              ...ctx(third.execution),
              subject: "report",
              assets: [
                {
                  kind: "produced",
                  content: {
                    media_type: "text/markdown",
                    encoding: "base64",
                    data: Buffer.from("A is complete.").toString("base64"),
                  },
                },
              ],
            },
            auth.token,
          )
        ).evidence;
        await release(third.execution);
        assert.equal((await node(initiative)).state, NodeState.Waiting);
      },
    );
    await t.test(
      "EX10.9 initiative assessment closes with child outcome",
      async () => {
        const fourth = await pull();
        assert.equal(fourth.execution.node_id, initiative);
        const testedInput = [repoAt("b")];
        const run = await verification(fourth.execution, testedInput, "true");
        const assessed = await cli.write<Assessed>(
          ["mission", "assessment", "submit", initiative],
          {
            ...ctx(fourth.execution),
            evidence_ids: [run.id, report.id],
            child_outcome_ids: [outcomeA],
            result: SUCCESS,
            rationale: "A is complete.",
            tested_input: testedInput,
          },
          auth.token,
        );
        assert.equal(assessed.node.state, NodeState.Completed);
        assert.deepEqual(assessed.assessment.child_node_ids, [objective]);
        assert.equal(assessed.outcome.result, SUCCESS);
      },
    );
    await t.test(
      "EX10.10 terminal graph has four finished executions and empty queue",
      async () => {
        assert.equal((await node(objective)).state, NodeState.Completed);
        assert.equal((await node(initiative)).state, NodeState.Completed);
        assert.deepEqual(
          (
            await cli.read<{ items: unknown[] }>([
              "scheduler",
              "queue",
              "list",
              project.id,
            ])
          ).items,
          [],
        );
        const executions = await cli.read<{ items: ExecutionRecord[] }>([
          "scheduler",
          "execution",
          "list",
          project.id,
        ]);
        assert.equal(executions.items.length, EXPECTED_EXECUTION_COUNT);
        assert.ok(
          executions.items.every(
            (item) =>
              item.claim_state === ClaimState.Finished &&
              item.claimant.runtime_identity === runtime,
          ),
        );
      },
    );
    await t.test(
      "EX10.11 deregistration removes inventory and prevents work",
      async () => {
        const ended = await cli.read<{ registered: boolean }>(
          ["worker", "instance", "deregister", runtime],
          auth.token,
        );
        assert.equal(ended.registered, false);
        assert.deepEqual(
          (
            await cli.read<{ items: unknown[] }>([
              "worker",
              "instance",
              "list",
              "--project",
              project.id,
            ])
          ).items,
          [],
        );
        assert.deepEqual((await health()).services.worker.projects, {});
        await cli.refuses(
          ["scheduler", "work", "pull", "--file", pullFile],
          auth.token,
          "gateway.registration.required",
        );
        assert.ok(hosts.fetch.length > UNOBSERVED_REQUEST_COUNT);
        assert.deepEqual(hosts.remote, []);
      },
    );
  },
);
