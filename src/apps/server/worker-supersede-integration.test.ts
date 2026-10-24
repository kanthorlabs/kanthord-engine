import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { Diagnostic } from "../../kernel/errors.ts";
import { requirePiTools, temporary } from "../../kernel/test-support.ts";
import { llmOperations } from "../../llm/contract.ts";
import { Intent, missionOperations } from "../../mission/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { ClaimState, schedulerOperations } from "../../scheduler/contract.ts";
import {
  workerOperations,
  type RepositoryTransport,
} from "../../worker/contract.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
  transport as localTransport,
} from "../../worker/unit/test-support.ts";
import { Worker, type WorkerOptions } from "../worker/index.ts";
import {
  enableCoveringAgents,
  gatewayFixture,
  humanCaller,
  provisionRepositoryCredentials,
  COVERING_WORKER_BINDINGS,
} from "./test-support.ts";

const TEST_TIMEOUT_MS = 180000;
const INSTANCE = "laptop";
const CONNECTION_A = "host-a";
const CONNECTION_B = "host-b";
const SUPERSEDED_CODE = "worker.instance.superseded";
const CREDENTIAL = "anthro-1";
const PROVIDER_KEY = "supersede-provider-key";
const FAST_HEARTBEAT_MS = 50;
const SLOW_INTERVAL_MS = 3600000;
const POLL_MS = 20;
const SLEEP_MIN_SECONDS = 70000;
const SLEEP_MAX_SECONDS = 80000;
const PS_PATH = "/bin/ps";
const TREE_PROCESSES_MIN = 2;
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;
const NODE = {
  name: "Supersede",
  requirement: "Run a long command",
  criterion: "The command ends",
  verifications: ["true"],
};

async function until<T>(
  read: () => Promise<T | undefined | false> | T | undefined | false,
  signal: AbortSignal,
): Promise<T> {
  for (;;) {
    const value = await read();
    if (value) return value;
    await delay(POLL_MS, undefined, { signal });
  }
}

function processesWith(marker: string): number[] {
  return execFileSync(PS_PATH, ["-A", "-o", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => pid !== process.pid);
}

async function seedRepository(t: TestContext): Promise<string> {
  const root = temporary(t);
  const seed = join(root, "seed");
  const bare = join(root, "bare.git");
  const git = simpleGit();
  await git.init(false, [seed, "--initial-branch=main"]);
  const seeded = simpleGit(seed);
  await seeded.addConfig("user.name", "Supersede Test");
  await seeded.addConfig("user.email", "supersede@example.invalid");
  await seeded.commit("initial", ["--allow-empty"]);
  await git.clone(seed, bare, ["--bare"]);
  return bare;
}

function localRepository(bare: string): RepositoryTransport {
  return {
    ...localTransport,
    clone: (_address, directory, context, deadlineMs, ssh) =>
      localTransport.clone(bare, directory, context, deadlineMs, ssh),
    cloneSnapshot: (_address, revision, directory, context, deadlineMs, ssh) =>
      localTransport.cloneSnapshot(
        bare,
        revision,
        directory,
        context,
        deadlineMs,
        ssh,
      ),
  };
}

async function instanceProject(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  const call = humanCaller(fixture);
  const empty = { params: {}, query: {} };
  await call(llmOperations.create, {
    ...empty,
    body: {
      name: CREDENTIAL,
      platform: "anthropic",
      metadata: null,
      secret: { key: PROVIDER_KEY },
    },
  });
  await enableCoveringAgents(
    { KANTHORD_ENDPOINT: fixture.endpoint, KANTHORD_TOKEN: fixture.token },
    {
      platform: "anthropic",
      credential: CREDENTIAL,
      configuration: CONFIGURATION,
    },
  );
  await provisionRepositoryCredentials(fixture);
  const instance = await call(workerOperations["instance.create"], {
    ...empty,
    body: { name: INSTANCE, worker: "coder@1", endpoint: fixture.endpoint },
  });
  assert.ok(instance.instance_configuration);
  await call(llmOperations.create, {
    ...empty,
    body: {
      name: CREDENTIAL,
      platform: "anthropic",
      metadata: null,
      holders: [INSTANCE],
      secret: { key: PROVIDER_KEY },
    },
  });
  const project = await call(projectOperations.create, {
    ...empty,
    body: { name: "worker-supersede" },
  });
  const bindingSet = await call(projectOperations["bindingSet.write"], {
    params: { project_id: project.id },
    query: {},
    body: {
      version: 1,
      bindings: {
        ...COVERING_WORKER_BINDINGS,
        repo: {
          kind: "repository",
          config: {
            available: true,
            platform: "github",
            address: "git@github.com:owner/repo.git",
            ssh_credential: "github-ssh",
            strategy: { base_branch: "main" },
            credential: "github",
          },
        },
        general: {
          kind: "worker",
          config: {
            worker: "coder@1",
            placement: "worker",
            worker_instances: [INSTANCE],
            entries: [{ agent: "swe@1", ...CONFIGURATION }],
          },
        },
      },
    } as never,
  });
  const mission = await call(missionOperations.get, {
    params: { project_id: project.id },
    query: {},
    body: null,
  });
  const implement = await call(missionOperations["node.create"], {
    params: { mission_id: mission.id },
    query: {},
    body: {
      filename: "implement-1.md",
      content: {
        ...NODE,
        intent: Intent.Implement,
        bindings: [bindingSet.bindings.repo!.id],
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: 1,
    },
  });
  const nodeId = implement.revisions[0]!.node_id;
  const running = () =>
    call(schedulerOperations.executionList, {
      params: { project_id: project.id },
      query: { node_id: nodeId },
      body: null,
    }).then((page) =>
      page.items.find((item) => item.claim_state === ClaimState.Running),
    );
  return { configuration: instance.instance_configuration, running };
}

test(
  "a superseded worker ends the child tree of a running bash tool before it returns the superseded reason",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    requirePiTools();
    const project = await instanceProject(t);
    const bare = await seedRepository(t);
    const marker = `sleep ${randomInt(SLEEP_MIN_SECONDS, SLEEP_MAX_SECONDS)}`;
    t.after(() => {
      for (const pid of processesWith(marker)) process.kill(pid, "SIGKILL");
    });
    const provider = scriptedProvider([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: `sh -c '${marker}' & ${marker}` }),
        { stopReason: "toolUse" },
      ),
    ]);
    const root = temporary(t);
    const options = (connectionName: string): WorkerOptions => ({
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        KANTHORD_WORKER_CONFIG: project.configuration,
      },
      connectionName,
      heartbeatIntervalMs: FAST_HEARTBEAT_MS,
      renewalIntervalMs: SLOW_INTERVAL_MS,
      modelRuntimeFactory: scriptedModelRuntime(provider),
      repositoryTransport: localRepository(bare),
      log: () => {},
    });
    const first = new Worker(options(CONNECTION_A));
    t.after(() => first.stop());
    const firstRun = first.run();
    await until(project.running, t.signal);
    await until(
      () => processesWith(marker).length >= TREE_PROCESSES_MIN,
      t.signal,
    );

    const second = new Worker(options(CONNECTION_B));
    t.after(() => second.stop());
    assert.equal(await second.start(), null);
    const error = await firstRun;
    const survivors = processesWith(marker);

    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, SUPERSEDED_CODE);
    assert.deepEqual(survivors, []);
  },
);
