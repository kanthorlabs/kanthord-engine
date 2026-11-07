import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  createProvider,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
} from "../../kernel/hpke.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
} from "../../custody/contract.ts";
import {
  InstanceLoginState,
  type LoginReportBody,
  type LoginSessionEntry,
} from "../../llm/contract.ts";
import { piProviderId, Platform } from "../../llm/platforms.ts";
import { LoginSessionMode } from "../../llm/sessions.ts";
import type { InstanceCopyKey } from "../../custody/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { EXCHANGE_UNAVAILABLE } from "./instance-exchange.ts";
import {
  copyKeysFixture,
  TEST_MACHINE_NAME,
} from "./copy-keys-test-support.ts";
import type { CopyKeys } from "./copy-keys.ts";
import { InstanceLogins } from "./instance-login.ts";

const INSTANCE = "laptop";
const SESSION_ID = "login_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL_NAME = "claude";
const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize?state=abc";
const DEVICE_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE = "ABCD-EFGH";
const COPY_CODE_VALUE = "authorization-code#state-value";
const NO_REPORTS = 0;
const CONFIG_ABSENT = "worker.machine.config_absent";
const ONE_REPORT = 1;
const RETRY_MS = 1;
const DEVICE_OPTION = "device_code";
const OAUTH_SECRET = {
  refresh: "private-refresh-token",
  access: "private-access-token",
  expires: 1700000900000,
};

function fakeProvider(
  id: string,
  login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>,
): Provider {
  return createProvider({
    id,
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
        name: "Fake OAuth",
        login,
        refresh: async () => {
          throw new Error("unexpected refresh");
        },
        toAuth: async () => {
          throw new Error("unexpected auth resolution");
        },
      },
    },
  });
}

interface Target {
  key: InstanceCopyKey;
  private_key: Buffer;
  copyKeys: CopyKeys;
}

function targetOf(key: InstanceCopyKey, private_key: Buffer): Target {
  return {
    key,
    private_key,
    copyKeys: {
      own: key,
      of: (holder) => (holder === key.holder ? key : null),
    },
  };
}

async function instanceTarget(): Promise<Target> {
  const pair = await generateX25519KeyPair();
  return targetOf(
    {
      holder: INSTANCE,
      sealed_to: keyFingerprint(pair.public_key),
      public_key: pair.public_key,
      private_key: () => Buffer.from(pair.private_key),
    },
    pair.private_key,
  );
}

async function fixture(
  provider: Provider,
  lose: (body: LoginReportBody) => boolean = () => false,
  target?: Target,
) {
  const { key, copyKeys, private_key } = target ?? (await instanceTarget());
  const reports: LoginReportBody[] = [];
  const keys: string[] = [];
  let lost = false;
  const logins = new InstanceLogins({
    copyKeys,
    providers: () => [provider],
    report: async (sessionId, body, idempotencyKey) => {
      assert.equal(sessionId, SESSION_ID);
      keys.push(idempotencyKey);
      if (!lost && lose(body)) {
        lost = true;
        throw new Diagnostic(EXCHANGE_UNAVAILABLE, "lost");
      }
      reports.push(body);
    },
    retryMs: RETRY_MS,
    log: () => {},
  });
  const until = async (read: () => boolean, signal: AbortSignal) => {
    while (!read()) await setImmediate(undefined, { signal });
  };
  const opened = (body: LoginReportBody, platform: string) =>
    openJSON(
      private_key,
      CREDENTIAL_SEAL_INFO,
      credentialSealAad({
        name: CREDENTIAL_NAME,
        platform,
        holder: key.holder,
        sealed_to: key.sealed_to,
      }),
      body.sealed!,
    );
  return { key, keys, logins, reports, until, opened };
}

function entry(
  platform: string,
  mode: LoginSessionEntry["mode"],
  code: string | null = null,
  holder: string = INSTANCE,
): LoginSessionEntry {
  return {
    session_id: SESSION_ID,
    name: CREDENTIAL_NAME,
    platform,
    mode,
    code,
    holder,
  };
}

test("an instance runs a copy_code login, supplies the code of the heartbeat entry and reports the credential sealed to its own key", async (t) => {
  let selected: string | undefined;
  let submitted: string | undefined;
  const provider = fakeProvider(
    piProviderId(Platform.AnthropicSubscription),
    async (interaction) => {
      selected = await interaction.prompt({
        type: "select",
        message: "Mode",
        options: [
          { id: "browser", label: "Browser" },
          { id: "copy_code", label: "Copy code" },
        ],
      });
      interaction.notify({ type: "auth_url", url: AUTHORIZATION_URL });
      submitted = await interaction.prompt({
        type: "manual_code",
        message: "Paste the code",
        placeholder: "code#state",
      });
      return { type: "oauth", ...OAUTH_SECRET, accountId: "dropped" };
    },
  );
  const f = await fixture(provider);
  f.logins.sync([
    entry(Platform.AnthropicSubscription, LoginSessionMode.CopyCode),
  ]);
  await f.until(() => f.reports.length > NO_REPORTS, t.signal);
  assert.deepEqual(
    [...f.reports],
    [
      {
        state: InstanceLoginState.Pending,
        address: AUTHORIZATION_URL,
        code: null,
        message: null,
        failure_reason: null,
      },
    ],
  );
  assert.equal(selected, LoginSessionMode.CopyCode);
  f.logins.sync([
    entry(
      Platform.AnthropicSubscription,
      LoginSessionMode.CopyCode,
      COPY_CODE_VALUE,
    ),
  ]);
  await f.until(
    () => f.reports.at(-1)?.state === InstanceLoginState.Completed,
    t.signal,
  );
  assert.equal(submitted, COPY_CODE_VALUE);
  const completed = f.reports.at(-1)!;
  assert.equal(completed.sealed_to, f.key.sealed_to);
  assert.deepEqual(
    await f.opened(completed, Platform.AnthropicSubscription),
    OAUTH_SECRET,
  );
  assert.equal(JSON.stringify(f.reports).includes(OAUTH_SECRET.access), false);
  await setImmediate();
  const sent = f.reports.length;
  f.logins.sync([
    entry(
      Platform.AnthropicSubscription,
      LoginSessionMode.CopyCode,
      COPY_CODE_VALUE,
    ),
  ]);
  await setImmediate();
  assert.equal(f.reports.length, sent);
});

test("an instance runs a device login, reports only the user code and the address, and aborts when the server no longer lists the session", async (t) => {
  const result = Promise.withResolvers<OAuthCredential>();
  let aborted = false;
  const provider = fakeProvider(
    piProviderId(Platform.OpenAICodex),
    async (interaction) => {
      const mode = await interaction.prompt({
        type: "select",
        message: "Mode",
        options: [
          { id: "browser", label: "Browser" },
          { id: DEVICE_OPTION, label: "Device code" },
        ],
      });
      assert.equal(mode, DEVICE_OPTION);
      interaction.notify({
        type: "device_code",
        verificationUri: DEVICE_URL,
        userCode: DEVICE_CODE,
      });
      interaction.signal?.addEventListener("abort", () => {
        aborted = true;
        result.reject(new Error("aborted"));
      });
      return await result.promise;
    },
  );
  const f = await fixture(provider);
  f.logins.sync([entry(Platform.OpenAICodex, LoginSessionMode.Device)]);
  await f.until(() => f.reports.length > NO_REPORTS, t.signal);
  assert.deepEqual(
    [f.reports[0]!.address, f.reports[0]!.code],
    [DEVICE_URL, DEVICE_CODE],
  );
  f.logins.sync([]);
  await f.until(() => aborted, t.signal);
  assert.equal(
    f.reports.some((report) => report.state === InstanceLoginState.Completed),
    false,
  );
});

function copyCodeProvider() {
  return fakeProvider(
    piProviderId(Platform.AnthropicSubscription),
    async (interaction) => {
      await interaction.prompt({
        type: "select",
        message: "Mode",
        options: [{ id: LoginSessionMode.CopyCode, label: "Copy code" }],
      });
      interaction.notify({ type: "auth_url", url: AUTHORIZATION_URL });
      await interaction.prompt({
        type: "manual_code",
        message: "Paste the code",
        placeholder: "code#state",
      });
      return { type: "oauth", ...OAUTH_SECRET };
    },
  );
}

test("a lost pending report is sent again at the next heartbeat entry", async (t) => {
  const f = await fixture(copyCodeProvider(), () => true);
  const listed = entry(
    Platform.AnthropicSubscription,
    LoginSessionMode.CopyCode,
  );
  f.logins.sync([listed]);
  await f.until(() => f.keys.length > NO_REPORTS, t.signal);
  assert.equal(f.reports.length, NO_REPORTS);
  f.logins.sync([listed]);
  await f.until(() => f.reports.length > NO_REPORTS, t.signal);
  assert.equal(f.reports[0]!.address, AUTHORIZATION_URL);
  f.logins.stop();
});

test("a lost pending report is sent again at the next resend", async (t) => {
  const f = await fixture(copyCodeProvider(), () => true);
  f.logins.sync([
    entry(Platform.AnthropicSubscription, LoginSessionMode.CopyCode),
  ]);
  await f.until(() => f.keys.length > NO_REPORTS, t.signal);
  assert.equal(f.reports.length, NO_REPORTS);
  f.logins.resend();
  await f.until(() => f.reports.length > NO_REPORTS, t.signal);
  assert.equal(f.reports[0]!.address, AUTHORIZATION_URL);
  await setImmediate();
  f.logins.resend();
  await setImmediate();
  assert.equal(f.reports.length, ONE_REPORT);
  f.logins.stop();
});

test("a lost completed report is retried with one idempotency key", async (t) => {
  const f = await fixture(
    copyCodeProvider(),
    (body) => body.state === InstanceLoginState.Completed,
  );
  f.logins.sync([
    entry(Platform.AnthropicSubscription, LoginSessionMode.CopyCode),
  ]);
  await f.until(() => f.reports.length > NO_REPORTS, t.signal);
  const sent = f.keys.length;
  f.logins.sync([
    entry(
      Platform.AnthropicSubscription,
      LoginSessionMode.CopyCode,
      COPY_CODE_VALUE,
    ),
  ]);
  await f.until(
    () => f.reports.at(-1)?.state === InstanceLoginState.Completed,
    t.signal,
  );
  const [lostKey, retriedKey] = f.keys.slice(sent);
  assert.ok(lostKey);
  assert.equal(retriedKey, lostKey);
});

test("a stopped instance starts no login flow", async () => {
  let started = false;
  const f = await fixture(
    fakeProvider(piProviderId(Platform.AnthropicSubscription), async () => {
      started = true;
      throw new Error("unexpected login");
    }),
  );
  f.logins.stop();
  f.logins.sync([
    entry(Platform.AnthropicSubscription, LoginSessionMode.CopyCode),
  ]);
  await setImmediate();
  assert.equal(started, false);
  assert.equal(f.reports.length, NO_REPORTS);
});

test("a session entry of a machine completes sealed to the machine key and sends the machine fingerprint", async (t) => {
  const keys = await copyKeysFixture(t);
  const f = await fixture(
    copyCodeProvider(),
    () => false,
    targetOf(keys.machine.key, keys.machine.pair.private_key),
  );
  const listed = (code: string | null) => [
    entry(
      Platform.AnthropicSubscription,
      LoginSessionMode.CopyCode,
      code,
      TEST_MACHINE_NAME,
    ),
  ];
  f.logins.sync(listed(null));
  await f.until(() => f.reports.length > NO_REPORTS, t.signal);
  f.logins.sync(listed(COPY_CODE_VALUE));
  await f.until(
    () => f.reports.at(-1)?.state === InstanceLoginState.Completed,
    t.signal,
  );
  const completed = f.reports.at(-1)!;
  assert.equal(completed.sealed_to, keys.machine.key.sealed_to);
  assert.deepEqual(
    await f.opened(completed, Platform.AnthropicSubscription),
    OAUTH_SECRET,
  );
});

test("a session entry of a machine with no machine key fails the session with the absent code", async (t) => {
  const keys = await copyKeysFixture(t);
  const absent = await copyKeysFixture(t, { machineInEnv: false });
  const f = await fixture(
    copyCodeProvider(),
    () => false,
    targetOf(keys.machine.key, keys.machine.pair.private_key),
  );
  const logins = new InstanceLogins({
    copyKeys: absent.keys,
    providers: () => [copyCodeProvider()],
    report: async (_sessionId, body) => {
      f.reports.push(body);
    },
    log: () => {},
  });
  const listed = (code: string | null) => [
    entry(
      Platform.AnthropicSubscription,
      LoginSessionMode.CopyCode,
      code,
      TEST_MACHINE_NAME,
    ),
  ];
  logins.sync(listed(null));
  await f.until(() => f.reports.length > NO_REPORTS, t.signal);
  logins.sync(listed(COPY_CODE_VALUE));
  await f.until(
    () => f.reports.at(-1)?.state === InstanceLoginState.Failed,
    t.signal,
  );
  const failed = f.reports.at(-1)!;
  assert.equal(failed.failure_reason, CONFIG_ABSENT);
  assert.equal(
    f.reports.some((report) => report.state === InstanceLoginState.Completed),
    false,
  );
});
