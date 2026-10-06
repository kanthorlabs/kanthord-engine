import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { ulid } from "ulid";
import { configuration } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import { NodeState } from "../../mission/contract.ts";
import {
  ClaimState,
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import { FAKE_SSH_IDENTITY, gatewayFixture } from "./test-support.ts";
import { environment, kanthord } from "./cli-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const NO_OUTPUT = "";
const NO_REVIEWER = "";
const UNSET_EXECUTION_ID = "";
const INITIAL_ENABLEMENT_REVISION = 1;
const INITIAL_BINDING_VERSION = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_EXECUTION = 1;
const FIRST_PRIORITY = 1;
const THIRD_MISSION_VERSION = 3;
const DEADLINE_DELTA = 7800000;
const SHORT_DEADLINE_DELTA = 1001;
const SPAWN_TIMEOUT = 10000;
const JOURNEY_TIMEOUT = 180000;
const MAX_WAIT_POLLS = 800;
const POLL_MS = 10;
const UNKNOWN_EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
};
const CONFIGURATION = {
  agentProvider: "default",
  modelIdentifier: "claude-sonnet-4-5",
  reasoningEffort: "off",
};
type Page<T> = { items: T[]; nextCursor: string | null };
type Node = { state: string; attempt: number; visibleRevision: number };
type Pull = {
  kind: string;
  execution: ExecutionRecord;
  idempotencyKey: string;
};
type Attempt = {
  attempt: number;
  closedAt: number | null;
  openedBy: { kind: string; executionId: string };
};
type Change = { revisions: { nodeId: string }[] };

function machineToken(
  directory: string,
  projectId: string,
  binding: string,
  name: string,
  env: NodeJS.ProcessEnv,
): string {
  assert.ok(projectId);
  assert.ok(binding);
  const args = [
    "jwt",
    "generate",
    "--project",
    projectId,
    "--binding",
    binding,
    "--name",
    name,
    "--config",
    join(directory, "server.yaml"),
  ];
  const entry = new URL("../../main.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.stdout.isTTY=true;process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
    ],
    { env, encoding: "utf8", timeout: SPAWN_TIMEOUT },
  );
  assert.equal(result.status, SUCCESS, result.stderr);
  assert.equal(result.stderr, NO_OUTPUT);
  const fragment = parse(result.stdout) as {
    token: string;
    clientSecret: string;
  };
  assert.ok(fragment.token && fragment.clientSecret);
  return fragment.token;
}

async function setup(t: TestContext, short = false) {
  const fixture = await gatewayFixture(t, {
    scheduler: short ? { releaseReserve: 1 } : {},
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
  });
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let nextFile = 0;
  const file = (body: unknown) => {
    const path = join(directory, `${++nextFile}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[], env = H): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, env = H) =>
    read<T>([...args, "--file", file(body)], env);
  const refuses = async (args: string[], code: string, env = H) => {
    const result = await kanthord(args, env);
    assert.equal(result.code, FAILURE, result.stderr);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    assert.equal(result.stdout, NO_OUTPUT);
  };
  await write(["llm", "credential", "create"], {
    name: "anthro-1",
    platform: "anthropic",
    metadata: null,
    secret: { key: "e2e-execution-secret" },
  });
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
  for (const agent of short ? ["swe@1"] : ["swe@1", "re@1"]) {
    const result = await write<{ revision: number }>(
      ["agent", "enablement", "put", agent],
      {
        agentProviders: [
          { name: "default", provider: "anthropic", credential: "anthro-1" },
        ],
        defaultConfiguration: CONFIGURATION,
      },
    );
    assert.equal(result.revision, INITIAL_ENABLEMENT_REVISION);
  }
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "execution",
  ]);
  const bindings = {
    repo: {
      kind: "repository",
      config: {
        available: true,
        platform: "github",
        address: "git@github.com:owner/repo.git",
        sshCredential: "github-ssh",
        strategy: { baseBranch: "main" },
        credential: "github",
      },
    },
    general: {
      kind: "worker",
      config: {
        worker: "general@1",
        instanceCount: 1,
        entries: [{ agent: "swe@1", ...CONFIGURATION }],
        ...(short ? { resourceBudget: { turns: 1, wallTimeMs: 1 } } : {}),
      },
    },
    ...(!short
      ? {
          reviewer: {
            kind: "worker",
            config: {
              worker: "reviewer@1",
              instanceCount: 1,
              entries: [{ agent: "re@1", ...CONFIGURATION }],
            },
          },
        }
      : {}),
  };
  const applied = await write<{
    bindingSetVersion: number;
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], { version: 1, bindings });
  assert.equal(
    applied.bindingSetVersion,
    INITIAL_BINDING_VERSION + Object.keys(bindings).length,
  );
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const initiative = await write<Change>(
    ["mission", "node", "create", mission.id],
    {
      filename: "initiative-1.md",
      kind: "initiative",
      content: CONTENT,
      reason: "plan",
      expectedMissionVersion: 1,
    },
  );
  const objective = await write<Change>(
    ["mission", "node", "create", mission.id],
    {
      filename: "objective-1.md",
      kind: "objective",
      content: { ...CONTENT, bindings: [applied.bindings.repo!.id] },
      reason: "plan",
      parentId: initiative.revisions[0]!.nodeId,
      expectedParentRevision: 1,
      expectedMissionVersion: 2,
    },
  );
  const objectiveId = objective.revisions[0]!.nodeId;
  const revision = (await read<Node>(["mission", "node", "get", objectiveId]))
    .visibleRevision;
  writePrivate(
    join(directory, "server.yaml"),
    stringify(
      configuration({ masterKey: fixture.config.masterKey }).getProperties(),
    ),
  );
  const G = {
    ...H,
    KANTHORD_TOKEN: machineToken(
      directory,
      project.id,
      "general",
      "general-a",
      H,
    ),
  };
  const R = short
    ? H
    : {
        ...H,
        KANTHORD_TOKEN: machineToken(
          directory,
          project.id,
          "reviewer",
          "reviewer-a",
          H,
        ),
      };
  const spare = short
    ? H
    : {
        ...H,
        KANTHORD_TOKEN: machineToken(
          directory,
          project.id,
          "general",
          "general-b",
          H,
        ),
      };
  const general = (
    await read<{ runtimeIdentity: string }>(["worker", "register"], G)
  ).runtimeIdentity;
  const reviewer = short
    ? NO_REVIEWER
    : (await read<{ runtimeIdentity: string }>(["worker", "register"], R))
        .runtimeIdentity;
  const generalPull = {
    resourceIdentity: "worker:kanthord:general",
    runtimeIdentity: general,
  };
  const reviewerPull = {
    resourceIdentity: "worker:kanthord:reviewer",
    runtimeIdentity: reviewer,
  };
  const pull = (env = G, body = generalPull, suffix: string[] = []) =>
    write<Pull>(["scheduler", "work", "pull", ...suffix], body, env);
  const get = (executionId: string, env = H) =>
    read<ExecutionRecord>(["scheduler", "execution", "get", executionId], env);
  const claim = (executionId: string, env = G) =>
    read<ExecutionRecord>(["scheduler", "claim", "get", executionId], env);
  const node = () => read<Node>(["mission", "node", "get", objectiveId]);
  const queue = () =>
    read<Page<{ nodeId: string }>>(["scheduler", "queue", "list", project.id]);
  const act = (state: string) => ({
    reason: "hold",
    expectedMissionVersion: THIRD_MISSION_VERSION,
    expectedState: state,
    expectedAttempt: FIRST_ATTEMPT,
  });
  return {
    fixture,
    directory,
    H,
    G,
    R,
    spare,
    general,
    reviewer,
    generalPull,
    reviewerPull,
    projectId: project.id,
    objectiveId,
    revision,
    file,
    read,
    write,
    refuses,
    pull,
    get,
    claim,
    node,
    queue,
    act,
  };
}

test(
  "Scheduler execution CLI journey E03.1–E03.16",
  { timeout: JOURNEY_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    let X = UNSET_EXECUTION_ID;
    let E = UNSET_EXECUTION_ID;
    const further = h.file({ furtherWork: true });
    const release = h.file({ furtherWork: false });
    await t.test(
      "E03.1 steps claim pins the attempt, binding and deadline",
      async () => {
        const result = await h.pull();
        assert.equal(result.kind, WorkPullKind.Claimed);
        const execution = result.execution;
        X = execution.executionId;
        assert.equal(execution.nodeId, h.objectiveId);
        assert.equal(execution.attempt, FIRST_ATTEMPT);
        assert.equal(execution.pinnedRevision, h.revision);
        assert.equal(execution.claimState, ClaimState.Running);
        assert.deepEqual(execution.credentials, []);
        assert.equal(execution.endedAt, null);
        assert.equal(execution.claimant.runtimeIdentity, h.general);
        assert.equal(
          execution.claimant.resourceIdentity,
          h.generalPull.resourceIdentity,
        );
        assert.ok(execution.claimant.clientId?.startsWith("client_identity_"));
        assert.equal(execution.expiredAt - execution.createdAt, DEADLINE_DELTA);
        assert.match(execution.traceId, /^[0-9a-f]{32}$/);
        assert.match(execution.rootSpanId, /^[0-9a-f]{16}$/);
        const node = await h.node();
        assert.equal(node.state, NodeState.Executing);
        assert.equal(node.attempt, FIRST_ATTEMPT);
        assert.equal(
          (await h.queue()).items.some((job) => job.nodeId === h.objectiveId),
          false,
        );
        const attempt = await h.read<Attempt>([
          "mission",
          "attempt",
          "get",
          h.objectiveId,
          "1",
        ]);
        const executionKind = "execution";
        assert.equal(attempt.openedBy.kind, executionKind);
        assert.equal(attempt.openedBy.executionId, X);
      },
    );
    await t.test(
      "E03.2 repeated pull returns the existing execution",
      async () => {
        assert.equal(
          (await h.pull(h.G, h.generalPull, ["--idempotency-key", ulid()]))
            .execution.executionId,
          X,
        );
        assert.equal(
          (
            await h.read<Page<ExecutionRecord>>([
              "scheduler",
              "execution",
              "list",
              h.projectId,
            ])
          ).items.length,
          SINGLE_EXECUTION,
        );
      },
    );
    await t.test("E03.3 claim reads enforce the owner", async () => {
      assert.equal((await h.claim(X)).claimState, ClaimState.Running);
      await h.refuses(
        ["scheduler", "claim", "get", X],
        "scheduler.execution.not_owner",
        h.R,
      );
    });
    await t.test(
      "E03.4 pull refuses mismatched, unregistered and human callers",
      async () => {
        await h.refuses(
          ["scheduler", "work", "pull", "--file", h.file(h.reviewerPull)],
          "scheduler.work.claimant_mismatch",
          h.G,
        );
        await h.refuses(
          ["scheduler", "work", "pull", "--file", h.file(h.generalPull)],
          "gateway.registration.required",
          h.spare,
        );
        await h.refuses(
          ["scheduler", "work", "pull", "--file", h.file(h.generalPull)],
          "gateway.authentication.unauthorized",
        );
      },
    );
    await t.test("E03.5 priority refuses the real live claim", async () => {
      await h.refuses(
        [
          "mission",
          "node",
          "priority",
          "set",
          h.objectiveId,
          "--file",
          h.file({
            value: FIRST_PRIORITY,
            expectedMissionVersion: THIRD_MISSION_VERSION,
          }),
        ],
        "mission.node.claim_live",
      );
    });
    await t.test(
      "E03.6 release predicate refuses unmet obligations",
      async () => {
        await h.refuses(
          ["scheduler", "execution", "release", X, "--file", release],
          "mission.release.obligation_unmet",
          h.G,
        );
        const row = await h.get(X);
        assert.equal(row.claimState, ClaimState.Running);
        assert.equal(row.endedAt, null);
      },
    );
    await t.test(
      "E03.7 further work finishes the execution and requeues its node",
      async () => {
        const result = await h.read<{
          executionId: string;
          endedAt: number;
          idempotencyKey: string;
        }>(["scheduler", "execution", "release", X, "--file", further], h.G);
        assert.equal(result.executionId, X);
        assert.ok(Number.isSafeInteger(result.endedAt));
        assert.ok(ulidSchema.safeParse(result.idempotencyKey).success);
        assert.equal((await h.claim(X)).claimState, ClaimState.Finished);
        const node = await h.node();
        assert.equal(node.state, NodeState.Available);
        assert.equal(node.attempt, FIRST_ATTEMPT);
        assert.equal(
          (await h.queue()).items.some((job) => job.nodeId === h.objectiveId),
          true,
        );
      },
    );
    await t.test("E03.8 ended release fails proof", async () =>
      h.refuses(
        ["scheduler", "execution", "release", X, "--file", further],
        "gateway.invocation.execution_proof_failed",
        h.G,
      ),
    );
    await t.test("E03.9 readiness wakes a parked reviewer pull", async () => {
      const pending = h.pull(h.R, h.reviewerPull);
      for (
        let poll = 0;
        poll < MAX_WAIT_POLLS && !h.fixture.scheduler.pulling(h.reviewer);
        poll++
      )
        await delay(POLL_MS);
      assert.equal(h.fixture.scheduler.pulling(h.reviewer), true);
      const ready = await h.write<{ node: Node }>(
        ["mission", "node", "ready", h.objectiveId],
        h.act(NodeState.Available),
      );
      assert.equal(ready.node.state, NodeState.Waiting);
      const result = await pending;
      assert.equal(result.kind, WorkPullKind.Claimed);
      E = result.execution.executionId;
      assert.equal(result.execution.nodeId, h.objectiveId);
      assert.equal(result.execution.attempt, FIRST_ATTEMPT);
      assert.equal(result.execution.pinnedRevision, h.revision);
      assert.equal(result.execution.claimant.runtimeIdentity, h.reviewer);
      assert.equal((await h.node()).state, NodeState.Evaluating);
    });
    await t.test(
      "E03.10 evaluation release also checks obligations",
      async () =>
        h.refuses(
          ["scheduler", "execution", "release", E, "--file", release],
          "mission.release.obligation_unmet",
          h.R,
        ),
    );
    await t.test(
      "E03.11 execution list filters by node and attempt",
      async () => {
        const result = await h.read<Page<ExecutionRecord>>([
          "scheduler",
          "execution",
          "list",
          h.projectId,
          "--node",
          h.objectiveId,
          "--attempt",
          "1",
        ]);
        assert.deepEqual(
          result.items.map((row) => row.executionId),
          [E, X],
        );
        assert.deepEqual(
          result.items.map((row) => row.claimState),
          [ClaimState.Running, ClaimState.Finished],
        );
        assert.equal(result.nextCursor, null);
        await h.refuses(
          ["scheduler", "execution", "list", h.projectId, "--attempt", "1"],
          "gateway.request.validation_failed",
        );
      },
    );
    await t.test("E03.12 human pause revokes the evaluation", async () => {
      const result = await h.write<{ node: Node }>(
        ["mission", "node", "pause", h.objectiveId],
        h.act(NodeState.Evaluating),
      );
      assert.equal(result.node.state, NodeState.Paused);
      const row = await h.claim(E, h.R);
      assert.equal(row.claimState, ClaimState.Finished);
      assert.ok(Number.isSafeInteger(row.endedAt));
    });
    await t.test("E03.13 disabled enablement answers no-work", async () => {
      await h.read([
        "agent",
        "enablement",
        "disable",
        "re@1",
        "--expected-revision",
        "1",
      ]);
      assert.equal(
        (await h.pull(h.R, h.reviewerPull)).kind,
        WorkPullKind.NoWork,
      );
    });
    await t.test(
      "E03.14 unknown execution refuses while ended execution remains readable",
      async () => {
        await h.refuses(
          ["scheduler", "execution", "get", UNKNOWN_EXECUTION],
          "scheduler.execution.not_found",
        );
        assert.equal((await h.get(X)).claimState, ClaimState.Finished);
      },
    );
    await t.test(
      "E03.15 all six published CLI validation refusals",
      async () => {
        for (const [args, code] of [
          [
            ["claim", "get", "invalid"],
            "cli.scheduler.claim.get.invalid_execution_id",
          ],
          [
            ["execution", "get", "invalid"],
            "cli.scheduler.execution.get.invalid_execution_id",
          ],
          [
            ["execution", "release", "invalid", "--file", further],
            "cli.scheduler.execution.release.invalid_execution_id",
          ],
          [
            ["execution", "list", "invalid"],
            "cli.scheduler.execution.list.invalid_project_id",
          ],
          [
            ["execution", "list", h.projectId, "--node", "invalid"],
            "cli.scheduler.execution.list.invalid_node_id",
          ],
          [
            [
              "execution",
              "list",
              h.projectId,
              "--node",
              h.objectiveId,
              "--attempt",
              "0",
            ],
            "cli.scheduler.execution.list.invalid_attempt",
          ],
        ] as const)
          await h.refuses(["scheduler", ...args], code);
      },
    );
    await t.test("E03.16 file and closed-schema refusals", async () => {
      await h.refuses(
        [
          "scheduler",
          "work",
          "pull",
          "--file",
          join(h.directory, "absent.json"),
        ],
        "cli.file.not_found",
        h.G,
      );
      await h.refuses(
        [
          "scheduler",
          "work",
          "pull",
          "--file",
          h.file({ ...h.generalPull, projectId: h.projectId }),
        ],
        "cli.file.schema_invalid",
        h.G,
      );
    });
  },
);

test(
  "Scheduler short deadline CLI journey E03.17–E03.19",
  { timeout: JOURNEY_TIMEOUT },
  async (t) => {
    const h = await setup(t, true);
    let X = UNSET_EXECUTION_ID;
    await t.test(
      "E03.17 binding wall time and reserve fix the deadline",
      async () => {
        const result = await h.pull();
        assert.equal(result.kind, WorkPullKind.Claimed);
        X = result.execution.executionId;
        assert.equal(
          result.execution.expiredAt - result.execution.createdAt,
          SHORT_DEADLINE_DELTA,
        );
      },
    );
    await t.test(
      "E03.18 expiry loses authority before settlement",
      async () => {
        await delay(1100);
        const row = await h.get(X);
        assert.equal(row.claimState, ClaimState.Lost);
        assert.equal(row.endedAt, null);
        await h.refuses(
          [
            "scheduler",
            "execution",
            "release",
            X,
            "--file",
            h.file({ furtherWork: true }),
          ],
          "gateway.invocation.execution_proof_failed",
          h.G,
        );
      },
    );
    await t.test(
      "E03.19 pull settles the loss and reuses the open attempt",
      async () => {
        const result = await h.pull();
        assert.equal(result.kind, WorkPullKind.Claimed);
        assert.notEqual(result.execution.executionId, X);
        assert.equal(result.execution.attempt, FIRST_ATTEMPT);
        const old = await h.get(X);
        assert.equal(old.claimState, ClaimState.Lost);
        assert.ok(old.endedAt !== null && old.endedAt >= old.expiredAt);
        const attempts = await h.read<Page<Attempt>>([
          "mission",
          "attempt",
          "list",
          h.objectiveId,
        ]);
        assert.deepEqual(
          attempts.items.map((attempt) => attempt.attempt),
          [FIRST_ATTEMPT],
        );
        assert.equal(attempts.items[0]!.closedAt, null);
      },
    );
  },
);
