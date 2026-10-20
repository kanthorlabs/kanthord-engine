import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createProvider,
  type OAuthCredential,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { httpClient } from "../../gateway/client.ts";
import { CancellationContext } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { llmOperations } from "../../llm/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { Worker } from "../worker/index.ts";
import { completed } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const INSTANCE = "laptop";
const CREDENTIAL_NAME = "claude";
const PLATFORM = "anthropic-subscription";
const PI_PROVIDER = "anthropic";
const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize?state=abc";
const COPY_CODE_VALUE = "authorization-code#state-value";
const COPY_CODE_OPTION = "copy_code";
const COMPLETED = "completed";
const FIRST_REVISION = 1;
const FAST_HEARTBEAT_MS = 50;
const SLOW_INTERVAL_MS = 3600000;
const WAIT_MS = 10000;
const POLL_MS = 20;
const OAUTH_SECRET = {
  refresh: "private-refresh-token",
  access: "private-access-token",
  expires: Date.now() + 3600000,
};

async function until<T>(read: () => Promise<T | undefined | false>) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await delay(POLL_MS);
  }
}

test("a live worker instance signs in through a fake pi-ai copy_code flow, and the server stores only the copy sealed to the instance key", async (t) => {
  const f = await gatewayFixture(t);
  const worker = httpClient(workerOperations, f.endpoint, f.token);
  const llm = httpClient(llmOperations, f.endpoint, f.token);
  const created = completed(
    await worker["instance.create"]({
      params: {},
      query: {},
      body: { name: INSTANCE, worker: "coder@1", endpoint: f.endpoint },
    }),
  );
  assert.ok(created.instance_configuration);
  let submitted: string | undefined;
  const provider = createProvider({
    id: PI_PROVIDER,
    models: [],
    api: {
      stream: () => {
        throw new Error("unexpected stream");
      },
      streamSimple: () => {
        throw new Error("unexpected stream");
      },
    },
    auth: {
      oauth: {
        name: "Fake Anthropic OAuth",
        login: async (
          interaction: ProviderAuthInteraction,
        ): Promise<OAuthCredential> => {
          const mode = await interaction.prompt({
            type: "select",
            message: "Mode",
            options: [
              { id: "browser", label: "Browser" },
              { id: COPY_CODE_OPTION, label: "Copy code" },
            ],
          });
          assert.equal(mode, COPY_CODE_OPTION);
          interaction.notify({ type: "auth_url", url: AUTHORIZATION_URL });
          submitted = await interaction.prompt({
            type: "manual_code",
            message: "Paste the code",
            placeholder: "code#state",
          });
          return { type: "oauth", ...OAUTH_SECRET };
        },
        refresh: async () => {
          throw new Error("unexpected refresh");
        },
        toAuth: async () => {
          throw new Error("unexpected auth resolution");
        },
      },
    },
  });
  const root = temporary(t);
  const records: string[] = [];
  const instance = new Worker({
    env: {
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_DATA_HOME: `${root}/data`,
      XDG_STATE_HOME: `${root}/state`,
      KANTHORD_WORKER_CONFIG: created.instance_configuration,
    },
    connectionName: "host-a",
    heartbeatIntervalMs: FAST_HEARTBEAT_MS,
    renewalIntervalMs: SLOW_INTERVAL_MS,
    oauthProviders: () => [provider],
    log: (line) => records.push(line),
  });
  const context = new CancellationContext();
  const running = instance.run(context);
  t.after(async () => {
    context.cancel();
    await running;
  });
  await until(async () => {
    const answer = await worker["instance.get"]({
      params: { instance_name: INSTANCE },
      query: {},
      body: null,
    });
    return completed(answer).connection !== null;
  });
  const login = completed(
    await llm.login(
      {
        params: {},
        query: {},
        body: { platform: PLATFORM, name: CREDENTIAL_NAME, holder: INSTANCE },
      },
      { idempotencyKey: "01ARZ3NDEKTSV4RRFFQ69G5FA1" },
    ),
  );
  assert.equal(login.address, AUTHORIZATION_URL);
  assert.equal(login.code, null);
  completed(
    await llm.login_code(
      {
        params: { session_id: login.session_id },
        query: {},
        body: { value: COPY_CODE_VALUE },
      },
      { idempotencyKey: "01ARZ3NDEKTSV4RRFFQ69G5FA2" },
    ),
  );
  const status = await until(async () => {
    const answer = completed(
      await llm.login_status({
        params: { session_id: login.session_id },
        query: {},
        body: null,
      }),
    );
    return answer.state === COMPLETED && answer;
  });
  assert.equal(status.failure_reason, null);
  assert.equal(submitted, COPY_CODE_VALUE);
  const copy = completed(
    await llm.get({
      params: { credential_name: CREDENTIAL_NAME },
      query: { holder: INSTANCE },
      body: null,
    }),
  );
  assert.deepEqual(
    [copy.holder, copy.sealed_to, copy.sealed_current],
    [INSTANCE, created.fingerprint, true],
  );
  assert.deepEqual(
    copy.revisions.map(({ revision }) => revision),
    [FIRST_REVISION],
  );
  const rows = f.store.database
    .prepare("SELECT holder FROM credential WHERE name = ?")
    .all(CREDENTIAL_NAME) as { holder: string }[];
  assert.deepEqual(
    rows.map(({ holder }) => holder),
    [INSTANCE],
  );
  const text = JSON.stringify([login, status, copy, records, f.logs]);
  assert.equal(text.includes(OAUTH_SECRET.access), false);
  assert.equal(text.includes(OAUTH_SECRET.refresh), false);
});
