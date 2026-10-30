import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";
import { directClient } from "../../gateway/index.ts";
import {
  type Operation,
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  EnvironmentStatus,
  projectOperations,
} from "../../project/contract.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import {
  FAKE_GITHUB_HOST_KEY_FINGERPRINT,
  FAKE_SSH_CREDENTIAL,
  FAKE_SSH_HOST,
  gatewayFixture,
} from "./test-support.ts";

const FIRST_VERSION = 1;
const CHILD_TIMEOUT_MS = 30000;
const TEST_FAILURE = 1;
const DIRECTORY_LINE = /^directory=(.+)$/m;
const ONBOARDING_POLLS = 200;
const ONBOARDING_POLL_MS = 25;

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  return result.data;
}

test("the gateway fixture onboards a repository binding with no environment to none", async (t) => {
  const f = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  const identity = await f.gateway.authentication.authenticate(
    `Bearer ${f.token}`,
  );
  const call = <T extends Operation>(
    operation: T,
    input: z.input<T["input"]>,
  ) =>
    directClient({ operation }, f.gateway.invocation).operation(input, {
      identity,
    });
  completed(
    await call(repositoryOperations.create, {
      params: {},
      query: {},
      body: {
        name: "github",
        platform: "github",
        metadata: null,
        secret: { key: "fake" },
      },
    }),
  );
  completed(
    await call(repositoryOperations.ssh_key_create, {
      params: {},
      query: {},
      body: { name: FAKE_SSH_CREDENTIAL },
    }),
  );
  completed(
    await call(repositoryOperations.host_key_pin, {
      params: { host: FAKE_SSH_HOST },
      query: {},
      body: { fingerprint: FAKE_GITHUB_HOST_KEY_FINGERPRINT },
    }),
  );
  const projectId = completed(
    await call(projectOperations.create, {
      params: {},
      query: {},
      body: { name: "onboarding" },
    }),
  ).id;
  completed(
    await call(projectOperations["bindingSet.write"], {
      params: { project_id: projectId },
      query: {},
      body: {
        version: FIRST_VERSION,
        bindings: {
          repo: {
            kind: "repository",
            config: {
              available: true,
              platform: "github",
              address: "git@github.com:owner/repo.git",
              ssh_credential: FAKE_SSH_CREDENTIAL,
              strategy: { base_branch: "main" },
              credential: "github",
            },
          },
        },
      },
    }),
  );
  const environments = async () =>
    completed(
      await call(projectOperations["environment.list"], {
        params: { project_id: projectId },
        query: {},
        body: null,
      }),
    ).items;
  for (let poll = 0; poll < ONBOARDING_POLLS; poll++) {
    const [state] = await environments();
    if (
      state !== undefined &&
      (state.status !== EnvironmentStatus.Pending || state.reason !== null)
    )
      break;
    await delay(ONBOARDING_POLL_MS);
  }
  const [state] = await environments();
  assert.ok(state);
  assert.equal(state.reason, null);
  assert.equal(state.status, EnvironmentStatus.None);
});

function failedChildTest(t: TestContext, body: string): string {
  const file = join(temporary(t), "stop.test.mjs");
  const support = (path: string) =>
    JSON.stringify(new URL(path, import.meta.url).href);
  writeFileSync(
    file,
    `import { test } from "node:test";
import { fakeGitHub, fakeS3 } from ${support("./test-support.ts")};
import { stopAfter, temporary } from ${support("../../kernel/test-support.ts")};
test("stops", async (t) => {
${body}
});
`,
  );
  const env = hostEnvironment();
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=spec", file],
    { env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  assert.equal(child.error, undefined, child.stdout);
  assert.equal(child.status, TEST_FAILURE, child.stdout);
  return child.stdout;
}

test("a fixture stop that throws leaves every later stop and directory removal to run", (t) => {
  const output = failedChildTest(
    t,
    `  const github = await fakeGitHub(t);
  await fetch(github.endpoint).catch(() => {});
  await fakeS3(t);
  stopAfter(t, () => {
    throw new Error("Second stop failed.");
  });
  console.log("directory=" + temporary(t));`,
  );
  assert.match(output, /Test stops failed\./);
  assert.match(output, /Fake GitHub failed\./);
  assert.match(output, /Second stop failed\./);
  const directory = DIRECTORY_LINE.exec(output)?.[1];
  assert.ok(directory, output);
  assert.equal(existsSync(directory), false);
});

test("a single stop that throws fails the test with its own error", (t) => {
  const output = failedChildTest(
    t,
    `  stopAfter(t, () => {
    throw new Error("Only stop failed.");
  });`,
  );
  assert.match(output, /Error: Only stop failed\./);
  assert.doesNotMatch(output, /Test stops failed\./);
});
