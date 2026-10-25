import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
  type CredentialAnswer,
  type SealedCopyAnswer,
} from "../../custody/contract.ts";
import type { InstanceCopyKey } from "../../custody/client.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  ResourceFailureReason,
  ResourceStatus,
  type ResourceObserver,
} from "../../kernel/health.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  sealJSON,
} from "../../kernel/hpke.ts";
import {
  Connection,
  COPY_REPORT_TEXT_MAX_LENGTH,
  type CopyReportBody,
  type ProviderCheckAnswer,
} from "../../llm/contract.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { LLM_PROVIDERS, Platform } from "../../llm/platforms.ts";
import type { LlmProvider } from "../../llm/provider.ts";
import { CopyChecks } from "./copy-checks.ts";
import { EXCHANGE_UNAVAILABLE, ExchangeFailure } from "./instance-exchange.ts";

const INSTANCE = "laptop";
const OPENAI = "openai";
const OPENAI_CAPABILITY = "model-list read";
const UNCHECKED_PLATFORM = "amazon-bedrock";
const UNCHECKED_CAPABILITY = "none";
const STALE = "stale-copy";
const ARCHIVED = "archived-copy";
const FIRST_REVISION = 1;
const NO_CREDENTIAL_VERSION = 0;
const NEXT_VERSION = 3;
const SHORT_TIMEOUT_MS = 20;
const REPORT_FAILED_CODE = "credential.revision.conflict";
const RUNS_FOR_ONE_VERSION = 1;
const RUNS_UNTIL_A_REFUSAL = 3;
const HEARTBEATS = 5;
const SERVER_FAILURE_CODE = "gateway.invocation.invalid_response";
const RUNS_FOR_A_CHANGE_DURING_A_RUN = 2;
const RUNS_FOR_THREE_VERSIONS = 3;

async function instanceKey(): Promise<InstanceCopyKey> {
  const pair = await generateX25519KeyPair();
  return {
    holder: INSTANCE,
    sealed_to: keyFingerprint(pair.public_key),
    public_key: pair.public_key,
    private_key: () => Buffer.from(pair.private_key),
  };
}

function record(
  name: string,
  platform: string,
  options: { sealed_current?: boolean; ended?: boolean } = {},
): CredentialAnswer {
  return {
    name,
    platform,
    holder: INSTANCE,
    sealed_to: null,
    sealed_current: options.sealed_current ?? true,
    revisions: [
      {
        id: `credential_${name}`,
        revision: FIRST_REVISION,
        metadata: null,
        created_at: 0,
        ended_at: options.ended ? 1 : null,
      },
    ],
  };
}

async function fixture(
  copies: { name: string; platform: string; secret: unknown }[],
  check: (
    secret: unknown,
    observe?: ResourceObserver,
    context?: Context,
  ) => Promise<ProviderCheckAnswer>,
  options: {
    reportFails?: boolean;
    timeoutMs?: number;
    providers?: Readonly<Record<string, LlmProvider>>;
  } = {},
) {
  const key = await instanceKey();
  const sealed = new Map<string, SealedCopyAnswer>();
  for (const copy of copies)
    sealed.set(copy.name, {
      name: copy.name,
      platform: copy.platform,
      revision: FIRST_REVISION,
      metadata: null,
      sealed: await sealJSON(
        key.public_key,
        CREDENTIAL_SEAL_INFO,
        credentialSealAad({
          name: copy.name,
          platform: copy.platform,
          holder: INSTANCE,
          sealed_to: key.sealed_to,
        }),
        copy.secret,
      ),
    });
  const reports: { name: string; body: CopyReportBody }[] = [];
  const logs: Record<string, unknown>[] = [];
  let lists = 0;
  const checks = new CopyChecks({
    key,
    context: background,
    timeoutMs: options.timeoutMs,
    providers: options.providers ?? {
      [OPENAI]: { check: (secret, _m, c, o) => check(secret, o, c) },
    },
    exchange: {
      copies: async () => {
        lists++;
        return [
          ...copies.map(({ name, platform }) => record(name, platform)),
          record(STALE, OPENAI, { sealed_current: false }),
          record(ARCHIVED, OPENAI, { ended: true }),
        ];
      },
      sealedCopy: async (name) => sealed.get(name)!,
      copyReport: async (name, body) => {
        if (options.reportFails)
          throw new Diagnostic(REPORT_FAILED_CODE, "conflict");
        reports.push({ name, body });
      },
    },
    log: (entry) => logs.push(entry),
  });
  return { checks, reports, logs, lists: () => lists };
}

test("the instance checks each live current copy once for each new credential version", async () => {
  const opened: unknown[] = [];
  const f = await fixture(
    [
      { name: "team-openai", platform: OPENAI, secret: { key: "bad" } },
      { name: "bedrock", platform: UNCHECKED_PLATFORM, secret: { key: "k" } },
    ],
    async (secret, observe) => {
      opened.push(secret);
      observe?.("status=401", ResourceFailureReason.Unauthorized);
      return { connection: Connection.Unauthorized, models: null };
    },
  );
  f.checks.observe(NO_CREDENTIAL_VERSION);
  await f.checks.idle();
  f.checks.observe(NO_CREDENTIAL_VERSION);
  await f.checks.idle();
  assert.equal(f.lists(), RUNS_FOR_ONE_VERSION);
  assert.deepEqual(opened, [{ key: "bad" }]);
  assert.deepEqual(f.reports, [
    {
      name: "team-openai",
      body: {
        revision: FIRST_REVISION,
        status: ResourceStatus.Unhealthy,
        capability: OPENAI_CAPABILITY,
        failure_reason: ResourceFailureReason.Unauthorized,
        models: null,
      },
    },
    {
      name: "bedrock",
      body: {
        revision: FIRST_REVISION,
        status: ResourceStatus.Unknown,
        capability: UNCHECKED_CAPABILITY,
        failure_reason: ResourceFailureReason.Unclassified,
        models: null,
      },
    },
  ]);
  f.checks.observe(NEXT_VERSION);
  await f.checks.idle();
  f.checks.observe(NO_CREDENTIAL_VERSION);
  await f.checks.idle();
  assert.equal(f.lists(), RUNS_FOR_THREE_VERSIONS);
  assert.equal(JSON.stringify(f.logs).includes("bad"), false);
});

test("a version change during a check runs one more check after it", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    [{ name: "team-openai", platform: OPENAI, secret: { key: "good" } }],
    async () => {
      await gate;
      return { connection: Connection.Ok, models: null };
    },
  );
  f.checks.observe(NO_CREDENTIAL_VERSION);
  f.checks.observe(NEXT_VERSION);
  f.checks.observe(NEXT_VERSION + 1);
  release();
  await f.checks.idle();
  await f.checks.idle();
  assert.equal(f.lists(), RUNS_FOR_A_CHANGE_DURING_A_RUN);
  assert.equal(f.reports.length, RUNS_FOR_A_CHANGE_DURING_A_RUN);
});

test("a check that rejects on its deadline abort reports deadline_exceeded", async () => {
  const f = await fixture(
    [{ name: "rejecting", platform: OPENAI, secret: { key: "k" } }],
    (_secret, _observe, context) =>
      new Promise((_resolve, reject) => {
        context?.signal.addEventListener("abort", () =>
          reject(context.signal.reason),
        );
      }),
    { timeoutMs: SHORT_TIMEOUT_MS },
  );
  f.checks.observe(NO_CREDENTIAL_VERSION);
  await f.checks.idle();
  assert.equal(f.reports[0]!.body.status, ResourceStatus.Unknown);
  assert.equal(
    f.reports[0]!.body.failure_reason,
    ResourceFailureReason.DeadlineExceeded,
  );
});

test("a check past its deadline reports unknown with deadline_exceeded, and only bounded models reach the report", async () => {
  const long = "m".repeat(COPY_REPORT_TEXT_MAX_LENGTH + 1);
  const slow = await fixture(
    [{ name: "slow", platform: OPENAI, secret: { key: "k" } }],
    () =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ connection: Connection.Ok, models: null }),
          SHORT_TIMEOUT_MS * 10,
        );
      }),
    { timeoutMs: SHORT_TIMEOUT_MS },
  );
  slow.checks.observe(NO_CREDENTIAL_VERSION);
  await slow.checks.idle();
  assert.equal(slow.reports[0]!.body.status, ResourceStatus.Unknown);
  assert.equal(
    slow.reports[0]!.body.failure_reason,
    ResourceFailureReason.DeadlineExceeded,
  );
  const listing = await fixture(
    [{ name: "listing", platform: OPENAI, secret: { key: "k" } }],
    async () => ({
      connection: Connection.Ok,
      models: [
        { id: "gpt-5", owned_by: "openai", created: 1 },
        { id: long, owned_by: null, created: null },
      ],
    }),
  );
  listing.checks.observe(NO_CREDENTIAL_VERSION);
  await listing.checks.idle();
  assert.deepEqual(listing.reports[0]!.body, {
    revision: FIRST_REVISION,
    status: ResourceStatus.Healthy,
    capability: OPENAI_CAPABILITY,
    failure_reason: null,
    models: [{ id: "gpt-5", owned_by: "openai", created: 1 }],
  });
});

test("a refused report logs its code and a stopped instance checks nothing more", async () => {
  const f = await fixture(
    [{ name: "team-openai", platform: OPENAI, secret: { key: "k" } }],
    async () => ({ connection: Connection.Ok, models: null }),
    { reportFails: true },
  );
  f.checks.observe(NO_CREDENTIAL_VERSION);
  await f.checks.idle();
  assert.deepEqual(f.logs, [
    {
      msg: "Worker instance credential report failed",
      credential_name: "team-openai",
      code: REPORT_FAILED_CODE,
    },
  ]);
  const context = new CancellationContext();
  context.cancel();
  const stopped = new CopyChecks({
    key: await instanceKey(),
    context,
    exchange: {
      copies: async () => [record("team-openai", OPENAI)],
      sealedCopy: () => assert.fail("no sealed read after a stop"),
      copyReport: () => assert.fail("no report after a stop"),
    },
    log: () => assert.fail("no log after a stop"),
  });
  stopped.observe(NO_CREDENTIAL_VERSION);
  await stopped.idle();
});

test("a run that ends on an indeterminate or server failure runs again at the next heartbeat, and a refusal does not", async () => {
  const outcomes: (Error | null)[] = [
    new ExchangeFailure(EXCHANGE_UNAVAILABLE, "indeterminate", null),
    new ExchangeFailure(
      SERVER_FAILURE_CODE,
      "server",
      HttpStatus.InternalServerError,
    ),
    new ExchangeFailure(REPORT_FAILED_CODE, "conflict", HttpStatus.Conflict),
  ];
  let lists = 0;
  const checks = new CopyChecks({
    key: await instanceKey(),
    context: background,
    exchange: {
      copies: async () => {
        lists++;
        const outcome = outcomes.shift();
        if (outcome) throw outcome;
        return [];
      },
      sealedCopy: () => assert.fail("no copy is listed"),
      copyReport: () => assert.fail("no copy is listed"),
    },
    log: () => {},
  });
  for (let heartbeat = 0; heartbeat < HEARTBEATS; heartbeat++) {
    checks.observe(NEXT_VERSION);
    await checks.idle();
  }
  assert.equal(lists, RUNS_UNTIL_A_REFUSAL);
});

const INSIDE_REFRESH_WINDOW_MS = 60000;
const NO_FETCH_CALLS = 0;

test("the copy check of an OAuth copy inside the pi-ai refresh window answers unauthorized without a refresh or a remote call", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  const subscription = LLM_PROVIDERS[Platform.AnthropicSubscription]!;
  const stores: unknown[] = [];
  const f = await fixture(
    [
      {
        name: "claude",
        platform: Platform.AnthropicSubscription,
        secret: {
          refresh: "copy-refresh-value",
          access: "copy-access-value",
          expires: Date.now() + INSIDE_REFRESH_WINDOW_MS,
        },
      },
    ],
    async () => {
      throw new Error("unexpected check");
    },
    {
      providers: {
        [Platform.AnthropicSubscription]: {
          check: (secret, metadata, context, observe, refreshStore) => {
            stores.push(refreshStore);
            return subscription.check(
              secret,
              metadata,
              context,
              observe,
              refreshStore,
            );
          },
        },
      },
    },
  );
  f.checks.observe(NO_CREDENTIAL_VERSION);
  await f.checks.idle();
  assert.deepEqual(stores, [undefined]);
  assert.equal(fetch.mock.callCount(), NO_FETCH_CALLS);
  assert.equal(f.reports[0]?.body.status, ResourceStatus.Unhealthy);
  assert.equal(
    f.reports[0]?.body.failure_reason,
    ResourceFailureReason.Unauthorized,
  );
});
