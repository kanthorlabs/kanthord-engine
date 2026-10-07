import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { ulid } from "ulid";
import { configuration } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import {
  createIdentity,
  identitySchema,
  ulidSchema,
} from "../../kernel/identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  InstanceActivity,
  instanceRecordSchema,
  workerOperations,
} from "../../worker/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { FAKE_SSH_IDENTITY, gatewayFixture } from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const NO_OUTPUT = "";
const FIRST_REVISION = 1;
const NATIVE_WORKER_INDEX = 1;
const SINGLE_ITEM = 1;
const SINGLE_INSTANCE = 1;
const SECOND_BINDING_VERSION = 2;
const THIRD_BINDING_VERSION = 3;
const REVIEWER_WORKER_INDEX = 3;
const FOURTH_BINDING_VERSION = 4;
const FIFTH_BINDING_VERSION = 5;
const SIXTH_BINDING_VERSION = 6;
const STRING_TYPE = "string";
const NATIVE = "general@1";
const EXTERNAL = "claude@1";
const AGENT = "swe@1";
const BINDING = "general";
const RESOURCE = "worker:kanthord:general";
const HOST = "kanthord";
const EXTERNAL_HOST = "external-harness";
const METHOD = "steps";
const HARNESS = "claude-code";
const EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const SPAWN_TIMEOUT = 10000;
const JOURNEY_TIMEOUT = 120000;
const TOKEN_DELAY = 1000;
const BUDGET = { turns: 200, wall_time_ms: 7200000 };
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
};
const ErrorCode = {
  Catalog: "worker.catalog.not_found",
  Unauthorized: "gateway.authentication.unauthorized",
  Required: "gateway.registration.required",
  Slot: "worker.instance.slot_unavailable",
  BindingProject: "cli.worker.instance.list.binding_without_project",
  Binding: "worker.instance.binding_unknown",
  Runtime: "cli.worker.instance.get.invalid_runtime_identity",
  Instance: "worker.instance.not_found",
  Execution: "worker.instance.no_live_execution",
} as const;
type Result = Awaited<ReturnType<typeof kanthord>>;
type Registration = typeof workerOperations.register.output._output;
type Instance = typeof instanceRecordSchema._output;
type CatalogPage =
  (typeof workerOperations)["catalog.list"]["output"]["_output"];
type Fixture = Awaited<ReturnType<typeof setup>>;

function success<T>(result: Result): T {
  assert.equal(result.code, SUCCESS, result.stderr);
  assert.equal(result.stderr, NO_OUTPUT);
  return JSON.parse(result.stdout) as T;
}

function refusal(result: Result, code: string): void {
  assert.equal(result.code, FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, NO_OUTPUT);
}

function file(directory: string, name: string, value: unknown): string {
  assert.ok(directory.startsWith("/"));
  assert.ok(name.endsWith(".json"));
  const path = join(directory, name);
  writePrivate(path, JSON.stringify(value));
  return path;
}

function machineToken(
  directory: string,
  projectId: string,
  name: string,
  env: NodeJS.ProcessEnv,
): string {
  assert.ok(identitySchema("project").safeParse(projectId).success);
  assert.ok(name);
  const args = [
    "jwt",
    "generate",
    "--project",
    projectId,
    "--binding",
    BINDING,
    "--name",
    name,
    "--config",
    join(directory, "issuance.yaml"),
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
    client_secret: string;
  };
  assert.ok(fragment.token && fragment.client_secret);
  return fragment.token;
}

function bindings(instanceCount: number) {
  assert.ok(Number.isSafeInteger(instanceCount));
  assert.ok(instanceCount >= SUCCESS);
  return {
    general: {
      kind: "worker",
      config: {
        worker: NATIVE,
        instance_count: instanceCount,
        entries: [{ agent: AGENT, ...CONFIGURATION }],
      },
    },
  };
}

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
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
  const project = success<{ id: string }>(
    await kanthord(["project", "create", "--name", "registration"], H),
  );
  const credential = file(directory, "anthropic.json", {
    name: "anthro-1",
    platform: "anthropic",
    metadata: null,
    secret: { key: "e2e-registration-secret" },
  });
  success(
    await kanthord(["llm", "credential", "create", "--file", credential], H),
  );
  const enablement = file(directory, "enablement.json", {
    agent_providers: [
      { name: "default", provider: "anthropic", credential: "anthro-1" },
    ],
    default_configuration: CONFIGURATION,
  });
  const enabled = success<{ revision: number }>(
    await kanthord(
      ["agent", "enablement", "put", AGENT, "--file", enablement],
      H,
    ),
  );
  assert.equal(enabled.revision, FIRST_REVISION);
  const initial = file(directory, "v1.json", {
    version: FIRST_REVISION,
    bindings: bindings(SINGLE_INSTANCE),
  });
  const applied = success<{ binding_set_version: number }>(
    await kanthord(
      ["project", "binding", "apply", project.id, "--file", initial],
      H,
    ),
  );
  assert.equal(applied.binding_set_version, SECOND_BINDING_VERSION);
  writePrivate(
    join(directory, "issuance.yaml"),
    stringify(
      configuration({ master_key: fixture.config.master_key }).getProperties(),
    ),
  );
  const A = {
    ...H,
    KANTHORD_TOKEN: machineToken(directory, project.id, "worker-a", H),
  };
  const B = {
    ...H,
    KANTHORD_TOKEN: machineToken(directory, project.id, "worker-b", H),
  };
  return { directory, projectId: project.id, H, A, B, fixture };
}

async function apply(
  f: Fixture,
  version: number,
  instanceCount: number | null,
): Promise<number> {
  assert.ok(f.projectId);
  assert.ok(version >= FIRST_REVISION);
  const path = file(f.directory, `v${version}.json`, {
    version,
    bindings: instanceCount === null ? {} : bindings(instanceCount),
  });
  return success<{ binding_set_version: number }>(
    await kanthord(
      ["project", "binding", "apply", f.projectId, "--file", path],
      f.H,
    ),
  ).binding_set_version;
}

test(
  "Worker registration CLI journey",
  { timeout: JOURNEY_TIMEOUT },
  async (t) => {
    const f = await setup(t);
    let ridA: string;
    let ridB: string;
    let ridB2: string;
    let record: Instance;
    const list = ["worker", "instance", "list", "--project", f.projectId];
    await t.test("E02.1 catalog lists declarations", async () => {
      const page = success<CatalogPage>(
        await kanthord(["worker", "list"], f.H),
      );
      assert.deepEqual(
        page.items.map((item) => item.name),
        [EXTERNAL, NATIVE, "opencode@1", "reviewer@1"],
      );
      assert.equal(page.next_cursor, null);
      assert.equal(page.items[NATIVE_WORKER_INDEX]!.host, HOST);
      assert.deepEqual(page.items[NATIVE_WORKER_INDEX]!.declared_node_states, [
        "Available",
      ]);
      assert.deepEqual(
        page.items[REVIEWER_WORKER_INDEX]!.declared_node_states,
        ["Waiting", "External.Requested"],
      );
      assert.deepEqual(page.items[NATIVE_WORKER_INDEX]!.required_node_format, [
        "name",
        "requirement",
        "criterion",
        "verifications",
        "bindings",
      ]);
    });
    await t.test("E02.2 catalog pages", async () => {
      const page = success<CatalogPage>(
        await kanthord(["worker", "list", "--limit", "2"], f.H),
      );
      assert.deepEqual(
        page.items.map((item) => item.name),
        [EXTERNAL, NATIVE],
      );
      assert.equal(typeof page.next_cursor, STRING_TYPE);
      const next = success<CatalogPage>(
        await kanthord(
          ["worker", "list", "--limit", "2", "--cursor", page.next_cursor!],
          f.H,
        ),
      );
      assert.deepEqual(
        next.items.map((item) => item.name),
        ["opencode@1", "reviewer@1"],
      );
      assert.equal(next.next_cursor, null);
    });
    await t.test("E02.3 host-specific catalog fields", async () => {
      const native = success<Record<string, unknown>>(
        await kanthord(["worker", "get", NATIVE], f.H),
      );
      const external = success<Record<string, unknown>>(
        await kanthord(["worker", "get", EXTERNAL], f.H),
      );
      assert.equal(native.host, HOST);
      assert.equal(native.method, METHOD);
      assert.equal(native.agent_name, AGENT);
      assert.deepEqual(native.resource_budget, BUDGET);
      assert.equal("harness" in native, false);
      assert.equal(external.host, EXTERNAL_HOST);
      assert.equal(external.harness, HARNESS);
      assert.deepEqual(external.resource_budget, {
        wall_time_ms: BUDGET.wall_time_ms,
      });
      assert.equal("method" in external, false);
    });
    await t.test("E02.4 unknown worker", async () =>
      refusal(
        await kanthord(["worker", "get", "tdd@1"], f.H),
        ErrorCode.Catalog,
      ),
    );
    await t.test("E02.5 machine cannot read catalog", async () =>
      refusal(await kanthord(["worker", "list"], f.A), ErrorCode.Unauthorized),
    );
    await t.test("E02.6 unregistered heartbeat", async () =>
      refusal(await kanthord(["worker", "heartbeat"], f.A), ErrorCode.Required),
    );
    await t.test("E02.7 register A", async () => {
      ridA = success<Registration>(
        await kanthord(["worker", "register"], f.A),
      ).runtime_identity;
      assert.ok(identitySchema("worker_instance").safeParse(ridA).success);
    });
    await t.test("E02.8 fresh registration key keeps identity", async () =>
      assert.equal(
        success<Registration>(await kanthord(["worker", "register"], f.A))
          .runtime_identity,
        ridA,
      ),
    );
    await t.test("E02.9 full slot refuses B", async () =>
      refusal(await kanthord(["worker", "register"], f.B), ErrorCode.Slot),
    );
    await t.test("E02.10 heartbeat prints null", async () =>
      assert.equal(success(await kanthord(["worker", "heartbeat"], f.A)), null),
    );
    await t.test("E02.11 filtered inventory", async () => {
      const page = success<{ items: Instance[]; next_cursor: string | null }>(
        await kanthord([...list, "--binding", BINDING], f.H),
      );
      assert.equal(page.items.length, SINGLE_ITEM);
      assert.equal(page.next_cursor, null);
      record = page.items[0]!;
      assert.ok(
        identitySchema("client_identity").safeParse(record.client_id).success,
      );
      assert.deepEqual(record, {
        runtime_identity: ridA,
        project_id: f.projectId,
        resource_identity: RESOURCE,
        worker_name: NATIVE,
        host: HOST,
        placement: "worker",
        client_id: record.client_id,
        name: "worker-a",
        activity: InstanceActivity.Idle,
        draining: false,
        registered: true,
      });
    });
    await t.test("E02.12 get equals inventory", async () =>
      assert.deepEqual(
        success(await kanthord(["worker", "instance", "get", ridA], f.H)),
        record,
      ),
    );
    await t.test("E02.13 local and server validation", async () => {
      refusal(
        await kanthord(
          ["worker", "instance", "list", "--binding", BINDING],
          f.H,
        ),
        ErrorCode.BindingProject,
      );
      refusal(
        await kanthord([...list, "--binding", "absent"], f.H),
        ErrorCode.Binding,
      );
      refusal(
        await kanthord(["worker", "instance", "get", "invalid"], f.H),
        ErrorCode.Runtime,
      );
    });
    await t.test("E02.14 live resume is idempotent", async () => {
      const result = success<
        Registration & { registered: boolean; idempotency_key: string }
      >(await kanthord(["worker", "instance", "resume", ridA], f.H));
      assert.equal(result.runtime_identity, ridA);
      assert.equal(result.registered, true);
      assert.ok(ulidSchema.safeParse(result.idempotency_key).success);
    });
    await t.test("E02.15 foreign client cannot deregister", async () =>
      refusal(
        await kanthord(["worker", "instance", "deregister", ridA], f.B),
        ErrorCode.Instance,
      ),
    );
    await t.test("E02.16 end replay and live inventory", async () => {
      const key = ulid();
      const args = [
        "worker",
        "instance",
        "deregister",
        ridA,
        "--idempotency-key",
        key,
      ];
      const result = success(await kanthord(args, f.A));
      assert.deepEqual(result, {
        runtime_identity: ridA,
        registered: false,
        idempotency_key: key,
      });
      assert.deepEqual(success(await kanthord(args, f.A)), result);
      refusal(
        await kanthord(["worker", "instance", "get", ridA], f.H),
        ErrorCode.Instance,
      );
      assert.deepEqual(success(await kanthord(list, f.H)), {
        items: [],
        next_cursor: null,
      });
    });
    await t.test("E02.17 ended resume needs running execution", async () =>
      refusal(
        await kanthord(["worker", "instance", "resume", ridA], f.H),
        ErrorCode.Execution,
      ),
    );
    await t.test("E02.18 freed slot admits B and refuses A", async () => {
      ridB = success<Registration>(
        await kanthord(["worker", "register"], f.B),
      ).runtime_identity;
      assert.notEqual(ridB, ridA);
      refusal(await kanthord(["worker", "register"], f.A), ErrorCode.Slot);
    });
    await t.test("E02.19 disabling binding ends registration", async () => {
      assert.equal(
        await apply(f, SECOND_BINDING_VERSION, SUCCESS),
        THIRD_BINDING_VERSION,
      );
      assert.deepEqual(success(await kanthord(list, f.H)), {
        items: [],
        next_cursor: null,
      });
      refusal(
        await kanthord(["worker", "heartbeat"], f.B),
        ErrorCode.Unauthorized,
      );
    });
    await t.test("E02.20 reenable admits a new identity", async () => {
      assert.equal(
        await apply(f, THIRD_BINDING_VERSION, SINGLE_INSTANCE),
        FOURTH_BINDING_VERSION,
      );
      ridB2 = success<Registration>(
        await kanthord(["worker", "register"], f.B),
      ).runtime_identity;
      assert.notEqual(ridB2, ridB);
    });
    await t.test("E02.21 old identity has no execution", async () =>
      refusal(
        await kanthord(["worker", "instance", "resume", ridB], f.H),
        ErrorCode.Execution,
      ),
    );
    await t.test(
      "E02.22 resume running execution on a second fixture",
      async (step) => {
        const second = await setup(step);
        const { runtime_identity: runtimeIdentity } = success<Registration>(
          await kanthord(["worker", "register"], second.A),
        );
        second.fixture.store.transaction((tx) => {
          const binding = second.fixture.project.workerBindingOf(
            tx,
            second.projectId,
            RESOURCE,
          );
          assert.ok(binding);
          const now = Date.now();
          tx.database
            .prepare(
              `INSERT INTO scheduler_execution
            (id, project_id, node_id, worker_binding_id, resource_identity, runtime_identity,
             attempt, pinned_revision, credentials, expired_at, trace_id, root_span_id, created_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, 1, '[]', ?, ?, ?, ?, NULL)`,
            )
            .run(
              EXECUTION,
              second.projectId,
              createIdentity("node"),
              binding.binding_id,
              RESOURCE,
              runtimeIdentity,
              now + BUDGET.wall_time_ms,
              "1234567890abcdef1234567890abcdef",
              "1234567890abcdef",
              now,
            );
        });
        success(
          await kanthord(
            ["worker", "instance", "deregister", runtimeIdentity],
            second.A,
          ),
        );
        const resumed = success<{ registered: boolean }>(
          await kanthord(
            ["worker", "instance", "resume", runtimeIdentity],
            second.H,
          ),
        );
        assert.equal(resumed.registered, true);
        assert.equal(
          success<Registration>(
            await kanthord(["worker", "register"], second.A),
          ).runtime_identity,
          runtimeIdentity,
        );
        const item = success<Instance>(
          await kanthord(
            ["worker", "instance", "get", runtimeIdentity],
            second.H,
          ),
        );
        assert.equal(item.activity, InstanceActivity.Executing);
        assert.equal(item.execution_id, EXECUTION);
      },
    );
    await t.test("E02.23 tombstone refuses old JWT after rebind", async () => {
      assert.equal(
        await apply(f, FOURTH_BINDING_VERSION, null),
        FIFTH_BINDING_VERSION,
      );
      assert.equal(
        await apply(f, FIFTH_BINDING_VERSION, SINGLE_INSTANCE),
        SIXTH_BINDING_VERSION,
      );
      refusal(
        await kanthord(["worker", "heartbeat"], f.B),
        ErrorCode.Unauthorized,
      );
      await delay(TOKEN_DELAY);
      const C = {
        ...f.H,
        KANTHORD_TOKEN: machineToken(f.directory, f.projectId, "worker-c", f.H),
      };
      const item = success<Registration>(
        await kanthord(["worker", "register"], C),
      );
      assert.ok(
        identitySchema("worker_instance").safeParse(item.runtime_identity)
          .success,
      );
      assert.notEqual(item.runtime_identity, ridB2);
    });
  },
);
