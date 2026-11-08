import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  apiKeySecretSchema,
  credentialPlatformList,
  secretSchemas,
  SecretShape,
} from "../custody/contract.ts";
import { background } from "../kernel/context.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { AUTHORIZATION_HEADER } from "../kernel/probe.ts";
import {
  CAPABILITY_MYSELF_READ,
  INTAKE_PLATFORMS,
  jiraMetadataSchema,
  Platform,
} from "./credential-platform.ts";

const TOKEN = "test_private-jira-token";
const SITE = "example.atlassian.net";
const CLOUD_ID = "0b6e1f2c-7a41-4d6f-9b53-3c1f0a9d8e21";
const EMAIL = "bot@example.com";
const METADATA = { site: SITE, cloud_id: CLOUD_ID, email: EMAIL };
const MYSELF_URL = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself`;
const BASIC_AUTHORIZATION = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
const ONE_CALL = 1;

function mockMyself(t: TestContext, status: number) {
  return t.mock.method(
    globalThis,
    "fetch",
    async (
      url: Parameters<typeof globalThis.fetch>[0],
      options?: RequestInit,
    ) => {
      assert.equal(url, MYSELF_URL);
      assert.equal(options?.method, HttpMethod.Get);
      assert.deepEqual(options?.headers, {
        [AUTHORIZATION_HEADER]: BASIC_AUTHORIZATION,
      });
      return new Response(null, { status });
    },
  );
}

test("the platform list holds jira alone with its api key shape and metadata fields", () => {
  assert.deepEqual(credentialPlatformList(INTAKE_PLATFORMS), {
    items: [
      {
        platform: Platform.Jira,
        secret_shape: SecretShape.ApiKey,
        login_modes: [],
        metadata_fields: ["site", "cloud_id", "email"],
        verifiable: true,
      },
    ],
  });
  assert.equal(INTAKE_PLATFORMS.jira.capability, CAPABILITY_MYSELF_READ);
  assert.equal(
    secretSchemas[INTAKE_PLATFORMS.jira.secret_shape],
    apiKeySecretSchema,
  );
  assert.equal(INTAKE_PLATFORMS.jira.metadata_schema, jiraMetadataSchema);
});

test("a jira credential with site, cloud_id and email stores", () => {
  assert.deepEqual(jiraMetadataSchema.parse(METADATA), METADATA);
  assert.deepEqual(apiKeySecretSchema.parse({ key: TOKEN }), { key: TOKEN });
});

for (const field of Object.keys(METADATA)) {
  test(`a jira credential without ${field} refuses`, () => {
    const metadata: Record<string, string> = { ...METADATA };
    delete metadata[field];
    assert.equal(jiraMetadataSchema.safeParse(metadata).success, false);
  });
}

test("a jira credential with a foreign field, a bad email or a bad cloud id refuses", () => {
  for (const metadata of [
    { ...METADATA, extra: "x" },
    { ...METADATA, email: "not-an-email" },
    { ...METADATA, cloud_id: "a/b" },
    { ...METADATA, site: " " },
  ])
    assert.equal(jiraMetadataSchema.safeParse(metadata).success, false);
});

test("the validator reads myself at the gateway of the cloud id with Basic email and token", async (t) => {
  const fetch = mockMyself(t, HttpStatus.OK);
  const status = await INTAKE_PLATFORMS.jira.probe!(
    { key: TOKEN },
    METADATA,
    background,
  );
  assert.equal(status, ResourceStatus.Healthy);
  assert.equal(fetch.mock.callCount(), ONE_CALL);
});

test("the validator answers unhealthy for a 401", async (t) => {
  const fetch = mockMyself(t, HttpStatus.Unauthorized);
  const status = await INTAKE_PLATFORMS.jira.probe!(
    { key: TOKEN },
    METADATA,
    background,
  );
  assert.equal(status, ResourceStatus.Unhealthy);
  assert.equal(fetch.mock.callCount(), ONE_CALL);
});
