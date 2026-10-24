import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";
import { directClient } from "../../gateway/index.ts";
import {
  OperationResultType,
  type Operation,
  type OperationResult,
} from "../../kernel/operation.ts";
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
