import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import { NodeKind } from "../../mission/contract.ts";

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
  kind: "initiative" | "objective" | "task",
  bindings: string[],
  parentId?: string,
) {
  const mission = await cli.read<{ id: string; version: number }>([
    "mission",
    "get",
    projectId,
  ]);
  const parent = parentId
    ? await cli.read<{ visible_revision: number }>([
        "mission",
        "node",
        "get",
        parentId,
      ])
    : null;
  const result = await cli.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename,
      kind,
      ...(parent
        ? {
            parent_id: parentId,
            expected_parent_revision: parent.visible_revision,
          }
        : {}),
      content: {
        ...NODE_CONTENT,
        bindings,
        verifications:
          kind === NodeKind.Initiative
            ? ["true"]
            : kind === NodeKind.Task
              ? ["grep -q hello hello.txt"]
              : NODE_CONTENT.verifications,
      },
      reason: "plan",
      expected_mission_version: mission.version,
    },
  );
  assert.ok(result.revisions.length);
  assert.ok(result.revisions[0]!.node_id);
  return result.revisions[0]!.node_id;
}
