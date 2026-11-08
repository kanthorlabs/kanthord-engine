import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { credentialAnswerSchema } from "../../custody/contract.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { ResourceStatus } from "../../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { cliSession } from "./cli-test-support.ts";
import { gatewayFixture } from "./test-support.ts";

const TOKEN = "test_private-jira-token";
const NAME = "jira";
const METADATA = {
  site: "example.atlassian.net",
  cloud_id: "0b6e1f2c-7a41-4d6f-9b53-3c1f0a9d8e21",
  email: "bot@example.com",
};
const BODY = {
  name: NAME,
  platform: "jira",
  metadata: METADATA,
  secret: { key: TOKEN },
};
const CREDENTIAL_PATH = "/api/intake/credential";
const MYSELF_ORIGIN = "https://api.atlassian.com/ex/jira/";
const FIRST_REVISION = 1;
const UNSUPPORTED_PLATFORM_CODE = "credential.platform.unsupported";
const INPUT_INVALID_CODE = "credential.input.invalid";
const NOT_FOUND_CODE = "credential.credential.not_found";

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const headers = {
    authorization: `Bearer ${fixture.token}`,
    "content-type": "application/json",
  };
  const session = cliSession(t, fixture.endpoint, fixture.token, TOKEN);
  return { fixture, headers, session };
}

test("the CLI creates, lists, gets and verifies a jira credential without a secret in any answer", async (t) => {
  const { session } = await setup(t);
  const created = await session.write<{ revisions: { revision: number }[] }>(
    ["intake", "credential", "create"],
    BODY,
  );
  assert.equal(created.revisions[0]?.revision, FIRST_REVISION);
  const got = await session.read<{ bindings: unknown[] }>([
    "intake",
    "credential",
    "get",
    NAME,
  ]);
  assert.deepEqual(got.bindings, []);
  const listed = await session.read<{ items: { name: string }[] }>([
    "intake",
    "credential",
    "list",
  ]);
  assert.deepEqual(
    listed.items.map(({ name }) => name),
    [NAME],
  );
  const original = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(url).startsWith(MYSELF_ORIGIN)
        ? new Response(null, { status: HttpStatus.Unauthorized })
        : original(url, init),
  );
  const verified = await session.read<{ status: string }>([
    "intake",
    "credential",
    "verify",
    NAME,
  ]);
  assert.equal(verified.status, ResourceStatus.Unhealthy);
});

test("the route group refuses a jira credential without a metadata field and a platform of another component", async (t) => {
  const { fixture, headers } = await setup(t);
  const post = (body: unknown) =>
    fixture.request(CREDENTIAL_PATH, {
      method: HttpMethod.Post,
      headers: { ...headers, "idempotency-key": createIdempotencyKey() },
      body: JSON.stringify(body),
    });
  const partial: Record<string, string> = { ...METADATA };
  delete partial.email;
  const missing = await post({ ...BODY, metadata: partial });
  assert.equal(missing.status, HttpStatus.BadRequest);
  assert.equal(
    errorSchema.parse(await missing.json()).error.code,
    INPUT_INVALID_CODE,
  );
  const foreign = await post({ ...BODY, platform: "github", metadata: null });
  assert.equal(foreign.status, HttpStatus.BadRequest);
  assert.equal(
    errorSchema.parse(await foreign.json()).error.code,
    UNSUPPORTED_PLATFORM_CODE,
  );
  const stored = await post(BODY);
  assert.equal(stored.status, HttpStatus.OK);
  assert.equal(
    credentialAnswerSchema.parse(await stored.json()).platform,
    BODY.platform,
  );
});

test("a repository credential is not an intake credential", async (t) => {
  const { fixture, headers, session } = await setup(t);
  await session.write(["repository", "credential", "create"], {
    name: "repo",
    platform: "github",
    metadata: null,
    secret: { key: TOKEN },
  });
  const response = await fixture.request(`${CREDENTIAL_PATH}/repo`, {
    headers,
  });
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal(
    errorSchema.parse(await response.json()).error.code,
    NOT_FOUND_CODE,
  );
});
