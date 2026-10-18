import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  ClaimableState,
  ImportFormat,
  NodeState,
  Intent,
} from "../../mission/contract.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import { environment, kanthord, until } from "./cli-support.ts";
import {
  enableCoveringAgents,
  FAKE_SSH_IDENTITY,
  gatewayFixture,
} from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const NO_OUTPUT = "";
const UTF8 = "utf8";
const MACOS = "platform.macos";
const XCODE = "toolchain.xcode";
const LINUX = "platform.linux";
const NODE_CREATE = 1;
const NO_ATTEMPT = 0;
const RELEASED_WORKERS = ["coder@1", "reviewer@1"];
const DECLARED_INTENTS = [Intent.Implement, Intent.Examine];
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;
const REPOSITORY = {
  kind: "repository",
  config: {
    available: true,
    platform: "github",
    address: "git@github.com:owner/api.git",
    ssh_credential: "github-ssh",
    strategy: { base_branch: "main" },
    credential: "github",
  },
};
const CONTENT = {
  name: "Add password reset to the iOS app",
  requirement: "Users reset their password on iOS.",
  criterion: "A reset email arrives on iOS.",
  verifications: ["xcodebuild test"],
};
type Change = { mission_version: number; revisions: { node_id: string }[] };
type Page<T> = { items: T[]; next_cursor: string | null };
type Pull = { kind: string; execution?: ExecutionRecord };
type Violation = {
  code: string;
  filename: string | null;
  node_id: string | null;
  details: { claims: { node_id: string | null; claim: string }[] };
};

function worker(name: string, tags: string[]) {
  return {
    kind: "worker",
    config: { worker: name, instance_count: 1, tags },
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
  let sequence = 0;
  const file = (body: unknown) => {
    const path = join(directory, `${++sequence}.json`);
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
  const refuses = async (args: string[], body: unknown, code: string) => {
    const result = await kanthord([...args, "--file", file(body)], H);
    assert.equal(result.code, FAILURE, result.stderr);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    assert.equal(result.stdout, NO_OUTPUT);
  };
  await write(["llm", "credential", "create"], {
    name: "anthro-1",
    platform: "anthropic",
    metadata: null,
    secret: { key: "e2e-match-secret" },
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
  await enableCoveringAgents(H, {
    platform: "anthropic",
    credential: "anthro-1",
    configuration: CONFIGURATION,
  });
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "atlas",
  ]);
  const linux = {
    "api-repo": REPOSITORY,
    "linux-coder": worker("coder@1", []),
    "linux-reviewer": worker("reviewer@1", []),
  };
  const applied = await write<{
    binding_set_version: number;
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: 1,
    bindings: linux,
  });
  const mission = await read<{ id: string; version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  const version = async () =>
    (
      await read<{ binding_set_version: number }>([
        "project",
        "get",
        project.id,
      ])
    ).binding_set_version;
  const apply = async (bindings: Record<string, unknown>) =>
    write(["project", "binding", "apply", project.id], {
      version: await version(),
      bindings,
    });
  const refusedApply = async (
    bindings: Record<string, unknown>,
    code: string,
  ) =>
    refuses(
      ["project", "binding", "apply", project.id],
      { version: await version(), bindings },
      code,
    );
  const node = {
    filename: "ios.md",
    content: {
      ...CONTENT,
      intent: Intent.Implement,
      tags: [MACOS],
      bindings: [applied.bindings["api-repo"]!.id],
    },
    tasks: [],
    reason: "plan",
    expected_mission_version: mission.version,
  };
  const instance = async (binding: string) => {
    const env = {
      ...H,
      KANTHORD_TOKEN: await fixture.machineToken(project.id, binding),
    };
    const { runtime_identity } = await read<{ runtime_identity: string }>(
      ["worker", "register"],
      env,
    );
    const pull = () =>
      write<Pull>(
        ["scheduler", "work", "pull"],
        {
          resource_identity: `worker:kanthord:${binding}`,
          runtime_identity,
        },
        env,
      );
    return { runtime_identity, pull };
  };
  return {
    fixture,
    directory,
    project,
    mission,
    linux,
    node,
    read,
    write,
    refuses,
    version,
    apply,
    refusedApply,
    instance,
  };
}

test("EF05.1-EF05.8 the match admits a node by intent and tags and refuses an uncovered node", async (t) => {
  const h = await setup(t);
  const macos = {
    ...h.linux,
    "macos-coder": worker("coder@1", [MACOS, XCODE]),
    "macos-reviewer": worker("reviewer@1", [MACOS]),
  };
  const nodes = () =>
    h.read<Page<{ id: string; state: string }>>([
      "mission",
      "node",
      "list",
      h.mission.id,
    ]);
  let nodeId = "";
  await t.test(
    "EF05.1 a node that requires an absent tag is refused",
    async () => {
      await h.refuses(
        ["mission", "node", "create", h.mission.id],
        h.node,
        "mission.node.tags_unmatched",
      );
      assert.deepEqual((await nodes()).items, []);
    },
  );
  await t.test(
    "EF05.2 the macOS bindings cover the node and the create succeeds",
    async () => {
      await h.apply(macos);
      const created = await h.write<Change>(
        ["mission", "node", "create", h.mission.id],
        h.node,
      );
      nodeId = created.revisions[0]!.node_id;
      assert.deepEqual(
        (await nodes()).items.map(({ id }) => id),
        [nodeId],
      );
    },
  );
  await t.test(
    "EF05.3 a binding set without the macOS reviewer is refused",
    async () => {
      const before = await h.version();
      const { "macos-reviewer": omitted, ...rest } = macos;
      assert.ok(omitted);
      await h.refusedApply(rest, "project.bindings.worker.node_unmatched");
      assert.equal(await h.version(), before);
    },
  );
  await t.test("EF05.4 an upper-case tag is refused", async () => {
    await h.refusedApply(
      { ...macos, "macos-coder": worker("coder@1", ["platform.macOS"]) },
      "project.bindings.worker.tags_invalid",
    );
  });
  await t.test(
    "EF05.7 the import preview reports the unmatched pairs and writes nothing",
    async () => {
      const out = join(h.directory, "export.json");
      await h.read([
        "mission",
        "export",
        h.mission.id,
        "--format",
        ImportFormat.Json,
        "--out",
        out,
      ]);
      const exported = JSON.parse(readFileSync(out, UTF8)) as {
        mission_version: number;
        entries: { id: string; tags?: string[] }[];
      };
      const preview = await h.write<{ violations: Violation[] }>(
        ["mission", "import", "preview", h.mission.id],
        {
          format: ImportFormat.Json,
          mission_id: h.mission.id,
          mission_version: exported.mission_version,
          reason: "plan",
          entries: exported.entries.map((entry) =>
            entry.id === nodeId ? { ...entry, tags: [LINUX] } : entry,
          ),
        },
      );
      assert.deepEqual(
        preview.violations.map(({ code, node_id, details }) => ({
          code,
          node_id,
          claims: details.claims.map(({ claim }) => claim),
        })),
        [
          {
            code: "mission.node.tags_unmatched",
            node_id: nodeId,
            claims: [ClaimableState.Available, ClaimableState.Waiting],
          },
        ],
      );
      const mission = await h.read<{ version: number }>([
        "mission",
        "get",
        h.project.id,
      ]);
      assert.equal(mission.version, h.mission.version + NODE_CREATE);
    },
  );
  await t.test(
    "EF05.8 the catalog answers the declared intents of each worker",
    async () => {
      const page = await h.read<Page<Record<string, unknown>>>([
        "worker",
        "list",
      ]);
      assert.deepEqual(
        page.items.map(({ name }) => name),
        RELEASED_WORKERS,
      );
      for (const item of page.items) {
        assert.deepEqual(item.declared_intents, DECLARED_INTENTS);
        assert.deepEqual(Object.keys(item).sort(), [
          "declared_intents",
          "declared_node_states",
          "host",
          "name",
        ]);
      }
    },
  );
  const linuxCoder = await h.instance("linux-coder");
  const waiting = linuxCoder.pull();
  await t.test(
    "EF05.5 a linux-coder pull answers no work and the node keeps its job",
    async () => {
      await until(
        () => h.fixture.scheduler.pulling(linuxCoder.runtime_identity),
        Boolean,
      );
      assert.equal((await linuxCoder.pull()).kind, WorkPullKind.NoWork);
      const node = await h.read<{ state: string }>([
        "mission",
        "node",
        "get",
        nodeId,
      ]);
      assert.equal(node.state, NodeState.Available);
      const queue = await h.read<Page<{ node_id: string }>>([
        "scheduler",
        "queue",
        "list",
        h.project.id,
      ]);
      assert.deepEqual(
        queue.items.map(({ node_id }) => node_id),
        [nodeId],
      );
    },
  );
  await t.test("EF05.6 a macos-coder pull claims the node", async () => {
    const macosCoder = await h.instance("macos-coder");
    const pulled = await macosCoder.pull();
    assert.equal(pulled.kind, WorkPullKind.Claimed);
    assert.equal(pulled.execution?.node_id, nodeId);
  });
  const parked: Promise<Pull>[] = [waiting];
  await t.test(
    "the evaluation claim of a macOS node goes only to macos-reviewer",
    async () => {
      const { version } = await h.read<{ version: number }>([
        "mission",
        "get",
        h.project.id,
      ]);
      const created = await h.write<Change>(
        ["mission", "node", "create", h.mission.id],
        {
          ...h.node,
          filename: "ios-review.md",
          expected_mission_version: version,
        },
      );
      const reviewId = created.revisions[0]!.node_id;
      const ready = await h.write<{ node: { state: string } }>(
        ["mission", "node", "ready", reviewId],
        {
          reason: "review",
          expected_mission_version: version + NODE_CREATE,
          expected_state: NodeState.Available,
          expected_attempt: NO_ATTEMPT,
        },
      );
      assert.equal(ready.node.state, NodeState.Waiting);
      const linuxReviewer = await h.instance("linux-reviewer");
      parked.push(linuxReviewer.pull());
      await until(
        () => h.fixture.scheduler.pulling(linuxReviewer.runtime_identity),
        Boolean,
      );
      assert.equal((await linuxReviewer.pull()).kind, WorkPullKind.NoWork);
      const macosReviewer = await h.instance("macos-reviewer");
      const claimed = await macosReviewer.pull();
      assert.equal(claimed.kind, WorkPullKind.Claimed);
      assert.equal(claimed.execution?.node_id, reviewId);
    },
  );
  await h.fixture.scheduler.quiesce();
  for (const pull of parked)
    assert.equal((await pull).kind, WorkPullKind.NoWork);
});
