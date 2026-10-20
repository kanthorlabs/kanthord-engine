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
import { InstanceLogins } from "./instance-login.ts";

const INSTANCE = "laptop";
const SESSION_ID = "login_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL_NAME = "claude";
const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize?state=abc";
const DEVICE_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE = "ABCD-EFGH";
const COPY_CODE_VALUE = "authorization-code#state-value";
const MAX_TURNS = 50;
const NO_REPORTS = 0;
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

async function fixture(provider: Provider) {
  const pair = await generateX25519KeyPair();
  const key = {
    holder: INSTANCE,
    sealed_to: keyFingerprint(pair.public_key),
    public_key: pair.public_key,
    private_key: () => Buffer.from(pair.private_key),
  };
  const reports: LoginReportBody[] = [];
  const logins = new InstanceLogins({
    key,
    providers: () => [provider],
    report: async (sessionId, body) => {
      assert.equal(sessionId, SESSION_ID);
      reports.push(body);
    },
    log: () => {},
  });
  const until = async (read: () => boolean) => {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (read()) return;
      await setImmediate();
    }
    assert.fail("The instance login did not reach the state");
  };
  const opened = (body: LoginReportBody, platform: string) =>
    openJSON(
      pair.private_key,
      CREDENTIAL_SEAL_INFO,
      credentialSealAad({
        name: CREDENTIAL_NAME,
        platform,
        holder: INSTANCE,
        sealed_to: key.sealed_to,
      }),
      body.sealed!,
    );
  return { key, logins, reports, until, opened };
}

function entry(
  platform: string,
  mode: LoginSessionEntry["mode"],
  code: string | null = null,
): LoginSessionEntry {
  return {
    session_id: SESSION_ID,
    name: CREDENTIAL_NAME,
    platform,
    mode,
    code,
  };
}

test("an instance runs a copy_code login, supplies the code of the heartbeat entry and reports the credential sealed to its own key", async () => {
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
  assert.equal(f.logins.pending(), true);
  await f.until(() => f.reports.length > NO_REPORTS);
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
  await f.until(() => f.reports.at(-1)?.state === InstanceLoginState.Completed);
  assert.equal(submitted, COPY_CODE_VALUE);
  const completed = f.reports.at(-1)!;
  assert.equal(completed.sealed_to, f.key.sealed_to);
  assert.deepEqual(
    await f.opened(completed, Platform.AnthropicSubscription),
    OAUTH_SECRET,
  );
  assert.equal(JSON.stringify(f.reports).includes(OAUTH_SECRET.access), false);
  await f.until(() => !f.logins.pending());
  f.logins.sync([
    entry(
      Platform.AnthropicSubscription,
      LoginSessionMode.CopyCode,
      COPY_CODE_VALUE,
    ),
  ]);
  assert.equal(f.logins.pending(), false);
});

test("an instance runs a device login, reports only the user code and the address, and aborts when the server no longer lists the session", async () => {
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
  await f.until(() => f.reports.length > NO_REPORTS);
  assert.deepEqual(
    [f.reports[0]!.address, f.reports[0]!.code],
    [DEVICE_URL, DEVICE_CODE],
  );
  f.logins.sync([]);
  assert.equal(f.logins.pending(), false);
  await f.until(() => aborted);
  assert.equal(
    f.reports.some((report) => report.state === InstanceLoginState.Completed),
    false,
  );
});
