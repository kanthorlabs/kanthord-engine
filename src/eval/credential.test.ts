import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SecretShape } from "../custody/contract.ts";
import { ANTHROPIC_SUBSCRIPTION_PLATFORM } from "../kernel/pi-provider.ts";
import { PRIVATE_FILE_MODE } from "../kernel/files.ts";
import { temporary } from "../kernel/test-support.ts";
import { PI_OAUTH_REFRESH_WINDOW_MS } from "../llm/refresh-watch.ts";
import {
  API_KEY_VARIABLE,
  AUTH_FILE_VARIABLE,
  CredentialSourceKind,
  credentialSourceOf,
  sandboxCredential,
} from "./credential.ts";

const LEAD_MS = 300000;
const NO_REFRESH = 0;
const ONE_REFRESH = 1;
const KEY = "eval-api-key-value";
const STORED_ACCESS = "eval-stored-access-value";
const STORED_REFRESH = "eval-stored-refresh-value";
const NEW_ACCESS = "eval-new-access-value";
const NEW_REFRESH = "eval-new-refresh-value";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const NEW_EXPIRES_IN_S = 28800;
const MARGIN_MS = 60000;
const MODE_MASK = 0o777;
const OTHER_ENTRY = { type: "api_key", key: "eval-other-key-value" };
const SECRETS = [KEY, STORED_ACCESS, STORED_REFRESH, NEW_ACCESS, NEW_REFRESH];

function authFile(t: TestContext, entries: unknown): string {
  const path = join(temporary(t), "auth.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

function oauthEntry(expires: number) {
  return {
    type: "oauth",
    access: STORED_ACCESS,
    refresh: STORED_REFRESH,
    expires,
  };
}

function mockRefresh(t: TestContext) {
  return t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.equal(String(url), TOKEN_URL);
    return Response.json({
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      expires_in: NEW_EXPIRES_IN_S,
    });
  });
}

function assertNoSecret(text: string): void {
  for (const secret of SECRETS) assert.equal(text.includes(secret), false);
}

function failureOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "",
    (error: unknown) => String(error),
  );
}

test("variable rule: exactly one of the two variables selects the source", () => {
  assert.deepEqual(credentialSourceOf({ [API_KEY_VARIABLE]: KEY }), {
    kind: CredentialSourceKind.Key,
    key: KEY,
  });
  assert.deepEqual(
    credentialSourceOf({ [AUTH_FILE_VARIABLE]: "/a/auth.json" }),
    {
      kind: CredentialSourceKind.AuthFile,
      path: "/a/auth.json",
    },
  );
});

test("variable rule: both variables, no variable or a relative path is an error that names the variables", () => {
  const both = {
    [API_KEY_VARIABLE]: KEY,
    [AUTH_FILE_VARIABLE]: "/a/auth.json",
  };
  for (const env of [both, {}, { [API_KEY_VARIABLE]: "" }])
    assert.throws(
      () => credentialSourceOf(env),
      (error: Error) =>
        error.message.includes(API_KEY_VARIABLE) &&
        error.message.includes(AUTH_FILE_VARIABLE) &&
        !error.message.includes(KEY),
    );
  assert.throws(
    () => credentialSourceOf({ [AUTH_FILE_VARIABLE]: "auth.json" }),
    new RegExp(AUTH_FILE_VARIABLE),
  );
});

test("the key source gives the anthropic platform and the key", async () => {
  assert.deepEqual(
    await sandboxCredential(
      { kind: CredentialSourceKind.Key, key: KEY },
      LEAD_MS,
    ),
    { platform: "anthropic", secret: { key: KEY } },
  );
});

test("a valid auth file entry outside the window gives the subscription secret and refreshes nothing", async (t) => {
  const fetch = mockRefresh(t);
  const expires = Date.now() + PI_OAUTH_REFRESH_WINDOW_MS + LEAD_MS + MARGIN_MS;
  const path = authFile(t, { anthropic: oauthEntry(expires) });
  const before = readFileSync(path, "utf8");
  assert.deepEqual(
    await sandboxCredential(
      { kind: CredentialSourceKind.AuthFile, path },
      LEAD_MS,
    ),
    {
      platform: "anthropic-subscription",
      secret: { refresh: STORED_REFRESH, access: STORED_ACCESS, expires },
    },
  );
  assert.equal(fetch.mock.callCount(), NO_REFRESH);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a token inside the window refreshes through pi-ai and the file holds the new token", async (t) => {
  const fetch = mockRefresh(t);
  const expires = Date.now() + PI_OAUTH_REFRESH_WINDOW_MS + LEAD_MS - MARGIN_MS;
  const path = authFile(t, {
    anthropic: oauthEntry(expires),
    other: OTHER_ENTRY,
  });
  const credential = await sandboxCredential(
    { kind: CredentialSourceKind.AuthFile, path },
    LEAD_MS,
  );
  assert.equal(fetch.mock.callCount(), ONE_REFRESH);
  assert.equal(credential.platform, ANTHROPIC_SUBSCRIPTION_PLATFORM);
  assert.ok("refresh" in credential.secret);
  assert.equal(credential.secret.access, NEW_ACCESS);
  assert.equal(credential.secret.refresh, NEW_REFRESH);
  assert.ok(
    credential.secret.expires >
      Date.now() + PI_OAUTH_REFRESH_WINDOW_MS + LEAD_MS,
  );
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.anthropic.type, SecretShape.OAuth);
  assert.equal(stored.anthropic.access, NEW_ACCESS);
  assert.equal(stored.anthropic.refresh, NEW_REFRESH);
  assert.equal(stored.anthropic.expires, credential.secret.expires);
  assert.deepEqual(stored.other, OTHER_ENTRY);
  assert.equal(statSync(path).mode & MODE_MASK, PRIVATE_FILE_MODE);
});

test("a failed refresh is an error that names the file and holds no token", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  );
  const path = authFile(t, { anthropic: oauthEntry(1) });
  const error = await failureOf(() =>
    sandboxCredential({ kind: CredentialSourceKind.AuthFile, path }, LEAD_MS),
  );
  assert.ok(error.includes(path));
  assertNoSecret(error);
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).anthropic.access,
    STORED_ACCESS,
  );
});

test("a missing file, an absent entry, a non-OAuth entry and a malformed file are errors that name the file and hold no token", async (t) => {
  const directory = temporary(t);
  const malformed = join(directory, "malformed.json");
  writeFileSync(malformed, `{"anthropic": ${STORED_ACCESS}`);
  const paths = [
    join(directory, "absent.json"),
    authFile(t, { other: OTHER_ENTRY }),
    authFile(t, { anthropic: { type: "api_key", key: KEY } }),
    authFile(t, { anthropic: { type: "oauth", access: STORED_ACCESS } }),
    malformed,
  ];
  for (const path of paths) {
    const error = await failureOf(() =>
      sandboxCredential({ kind: CredentialSourceKind.AuthFile, path }, LEAD_MS),
    );
    assert.ok(error.includes(path));
    assertNoSecret(error);
  }
});
