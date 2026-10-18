import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import { Intent, type TaskWrite } from "../../mission/contract.ts";

const SUCCESS = 0;
const FAILURE = 1;
const NO_OUTPUT = "";
export const JOURNEY_TIMEOUT_MS = 120000;
export const GITHUB_KEY = "test_journey_github_key";
export const PROVIDER_KEY = "test_journey_provider_key";
export const REPOSITORY_ADDRESS = "git@github.com:owner/repo.git";
export const GATED_ADDRESS = "git@github.com:owner/gated.git";
export const NODE_CONTENT = {
  name: "Greetings",
  requirement: "Write hello.txt",
  criterion: "hello.txt exists",
  verifications: ["test -f hello.txt"],
  bindings: [] as string[],
};

export function journeyClient(t: TestContext, endpoint: string, token: string) {
  const directory = temporary(t);
  const human = {
    ...environment(directory),
    KANTHORD_ENDPOINT: endpoint,
    KANTHORD_TOKEN: token,
  };
  const secrets = [token, GITHUB_KEY, PROVIDER_KEY];
  let sequence = 0;
  function file(body: unknown) {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  }
  async function read<T>(args: string[], machine?: string): Promise<T> {
    const result = await kanthord(args, {
      ...human,
      KANTHORD_TOKEN: machine ?? token,
    });
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    assert.ok(secrets.every((secret) => !result.stdout.includes(secret)));
    assert.ok(!result.stdout.includes('"put_url"'));
    return JSON.parse(result.stdout) as T;
  }
  function write<T>(args: string[], body: unknown, machine?: string) {
    return read<T>([...args, "--file", file(body)], machine);
  }
  async function refuses(args: string[], machine: string, code: string) {
    const result = await kanthord(args, { ...human, KANTHORD_TOKEN: machine });
    assert.equal(result.code, FAILURE);
    assert.ok(result.stderr.startsWith(`${code}:`));
    assert.equal(result.stdout, NO_OUTPUT);
    assert.ok(secrets.every((secret) => !result.stderr.includes(secret)));
  }
  return { directory, human, secrets, file, read, write, refuses };
}

export async function createJourneyNode(
  cli: ReturnType<typeof journeyClient>,
  projectId: string,
  filename: string,
  intent: Intent,
  bindings: string[],
  tasks: TaskWrite[] = [],
) {
  const mission = await cli.read<{ id: string; version: number }>([
    "mission",
    "get",
    projectId,
  ]);
  const result = await cli.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename,
      content: {
        ...NODE_CONTENT,
        bindings,
        intent,
        verifications:
          intent === Intent.Examine ? ["true"] : NODE_CONTENT.verifications,
      },
      tasks,
      reason: "plan",
      expected_mission_version: mission.version,
    },
  );
  assert.ok(result.revisions.length);
  const nodeId = result.revisions[0]!.node_id;
  assert.ok(nodeId);
  return nodeId;
}

export async function createJourneyTask(
  cli: ReturnType<typeof journeyClient>,
  projectId: string,
  nodeId: string,
  filename: string,
) {
  const mission = await cli.read<{ version: number }>([
    "mission",
    "get",
    projectId,
  ]);
  const node = await cli.read<{
    filename: string;
    visible_revision: number;
    content: typeof NODE_CONTENT & { intent: Intent; tags: string[] };
  }>(["mission", "node", "get", nodeId]);
  const current = await cli.read<{
    tasks: { id: string; filename: string; content: typeof NODE_CONTENT }[];
  }>([
    "mission",
    "node",
    "revision",
    "get",
    nodeId,
    String(node.visible_revision),
  ]);
  const result = await cli.write<{
    revisions: { tasks: { id: string; filename: string }[] }[];
  }>(["mission", "node", "update", nodeId], {
    filename: node.filename,
    content: node.content,
    tasks: [
      ...current.tasks,
      {
        filename,
        content: {
          name: NODE_CONTENT.name,
          requirement: NODE_CONTENT.requirement,
          criterion: NODE_CONTENT.criterion,
          bindings: [],
          verifications: ["grep -q hello hello.txt"],
        },
      },
    ],
    reason: "plan",
    expected_revision: node.visible_revision,
    expected_mission_version: mission.version,
  });
  const task = result.revisions[0]?.tasks.find(
    (item) => item.filename === filename,
  );
  assert.ok(task);
  return task.id;
}
