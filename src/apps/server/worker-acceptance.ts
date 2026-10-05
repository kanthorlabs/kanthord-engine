import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { configuration } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture, objectSink, sinkStorage } from "./test-support.ts";

const SUCCESS = 0;
const EMPTY = "";
export const WORKER_TEST_KEY = "test_worker_provider_key";
export const WORKER_DEFAULTS = {
  agentProvider: "default",
  modelIdentifier: "claude-sonnet-4-5",
  reasoningEffort: "off",
};

export async function workerAcceptance(t: TestContext, host = false) {
  const sink = host ? await objectSink(t) : undefined;
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => ({
        hostname: "github.com",
        port: 22,
        identityFiles: ["~/.ssh/id_acceptance"],
        identitiesOnly: true,
      }),
    },
    ...(sink ? { standIns: { intakeStorage: sinkStorage(sink) } } : {}),
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
    assert.equal(result.stderr, EMPTY);
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
  await write(["repository", "credential", "create"], {
    name: "github-ssh",
    platform: "ssh",
    metadata: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_acceptance",
    },
    secret: {},
  });
  await write(["worker", "agent", "enablement", "put", "swe@1"], {
    agentProviders: [
      { name: "default", provider: "anthropic", credential: "anthro-1" },
    ],
    defaultConfiguration: WORKER_DEFAULTS,
  });
  const storage = {
    endpoint: "https://s3.example.com",
    bucket: "evidence",
    region: "eu-central-1",
  };
  if (host)
    await write(["storage", "credential", "create"], {
      name: "store",
      platform: "s3",
      metadata: storage,
      secret: {
        accessKeyId: "test_access_key",
        secretAccessKey: "test_secret_key",
      },
    });
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
      ...(host
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
          strategy: { baseBranch: "main" },
          sshCredential: "github-ssh",
          credential: "github",
        },
      },
      general: {
        kind: "worker",
        config: {
          worker: "general@1",
          instanceCount: 1,
          entries: [{ agent: "swe@1", ...WORKER_DEFAULTS }],
        },
      },
    },
  });
  const configPath = join(directory, "server.yaml");
  writePrivate(
    configPath,
    stringify(
      configuration({ masterKey: fixture.config.masterKey }).getProperties(),
    ),
  );
  function machine(name: string) {
    const args = [
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
    const entry = new URL("../../main.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.stdout.isTTY=true;process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
      ],
      { env: human, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, SUCCESS, result.stderr);
    assert.equal(result.stderr, EMPTY);
    return parse(result.stdout) as { token: string; clientSecret: string };
  }
  if (!host)
    await read([
      "worker",
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
    projectId: project.id,
    bindings: bindingSet.bindings,
    read,
    write,
    machine,
    sink,
    directory,
  };
}
