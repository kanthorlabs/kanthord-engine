import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { decode } from "hono/jwt";
import { parse, stringify } from "yaml";
import { deriveClientSecret } from "../../gateway/auth/jwt.ts";
import { isString } from "../../kernel/values.ts";
import { CONFIG_VERSION, configuration } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord, kanthordTerminal } from "./cli-test-support.ts";
import {
  COVERING_WORKER_BINDINGS,
  createFakeSshCredential,
  enableCoveringAgents,
  fakeS3,
  gatewayFixture,
} from "./test-support.ts";

const SUCCESS = 0;
const NO_STDERR = "";
export const WORKER_TEST_KEY = "test_worker_provider_key";
export const WORKER_DEFAULTS = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;

export const serverInstanceName = (index: number) => `server-${index + 1}`;

export async function workerAcceptance(
  t: TestContext,
  host = false,
  options: {
    stateDirectory?: string;
    slotLimit?: number;
    containerImage?: string;
    fakeSlots?: boolean;
    fixtureOptions?: Parameters<typeof gatewayFixture>[1];
  } = {},
) {
  const s3 = host ? await fakeS3(t) : undefined;
  const fixture = await gatewayFixture(t, {
    ...options.fixtureOptions,
    stateDirectory: options.stateDirectory,
    serverSlotLimit: options.slotLimit,
    containerImage: options.containerImage,
    fakeSlots: options.fakeSlots,
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
  });
  const directory = temporary(t);
  const human = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let sequence = 0;
  async function read<T>(args: string[], env = human): Promise<T> {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, NO_STDERR);
    assert.ok(!result.stdout.includes(WORKER_TEST_KEY));
    return JSON.parse(result.stdout) as T;
  }
  function write<T>(args: string[], body: unknown) {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return read<T>([...args, "--file", path]);
  }
  for (const [group, name, platform, key] of [
    ["llm", "anthro-1", "anthropic", WORKER_TEST_KEY],
    ["repository", "github", "github", "test_github_key"],
  ] as const)
    await write([group, "credential", "create"], {
      name,
      platform,
      metadata: null,
      secret: { key },
    });
  await createFakeSshCredential(read);
  await enableCoveringAgents(human, {
    platform: "anthropic",
    credential: "anthro-1",
    configuration: WORKER_DEFAULTS,
  });
  const storage = s3 && {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: "eu-central-1",
  };
  if (storage)
    await write(["storage", "credential", "create"], {
      name: "store",
      platform: "s3",
      metadata: storage,
      secret: {
        access_key_id: "test_access_key",
        secret_access_key: "test_secret_key",
      },
    });
  await read([
    "worker",
    "instance",
    "create",
    serverInstanceName(0),
    "--worker",
    "coder@1",
    "--placement",
    "server",
  ]);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    host ? "worker-host" : "worker-app",
  ]);
  const bindingSet = await write<{
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: 1,
    bindings: {
      ...COVERING_WORKER_BINDINGS,
      ...(storage
        ? {
            store: {
              kind: "storage",
              config: {
                available: true,
                ...storage,
                prefix: "kanthord",
                credential: "store",
              },
            },
          }
        : {}),
      repo: {
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
      general: {
        kind: "worker",
        config: {
          worker: "coder@1",
          worker_instances: [serverInstanceName(0)],
          entries: [{ agent: "swe@1", ...WORKER_DEFAULTS }],
        },
      },
    },
  });
  const configPath = join(directory, "server.yaml");
  writePrivate(
    configPath,
    stringify(
      configuration({
        version: CONFIG_VERSION,
        master_key: fixture.config.master_key,
      }).getProperties(),
    ),
  );
  async function machine(name: string) {
    const args = [
      "auth",
      "jwt",
      "generate",
      "--project",
      project.id,
      "--binding",
      "general",
      "--name",
      name,
      "--config",
      configPath,
    ];
    const result = await kanthordTerminal(args, human);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, NO_STDERR);
    const { token } = parse(result.stdout) as { token: string };
    const { sub } = decode(token).payload;
    assert.ok(isString(sub));
    return {
      token,
      client_secret: deriveClientSecret(
        fixture.config.master_key,
        fixture.config.gateway.auth.version,
        sub,
      ),
    };
  }
  if (!host)
    await read([
      "agent",
      "enablement",
      "disable",
      "swe@1",
      "--expected-revision",
      "1",
    ]);
  return {
    fixture,
    human,
    project_id: project.id,
    bindings: bindingSet.bindings,
    read,
    write,
    machine,
    s3,
    directory,
  };
}
