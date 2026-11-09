import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { AUTHORIZATION_HEADER } from "../kernel/probe.ts";
import { INTAKE_PLATFORMS } from "./credential-platform.ts";
import {
  SLACK_AUTH_TEST_URL,
  SLACK_NOT_OK_ANSWER,
  SLACK_OK_ANSWER,
  SLACK_USER_TOKEN,
} from "./slack-test-support.ts";

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

function mockAuthTest(t: TestContext, answer: string) {
  return t.mock.method(
    globalThis,
    "fetch",
    async (
      url: Parameters<typeof globalThis.fetch>[0],
      options?: RequestInit,
    ) => {
      assert.equal(url, SLACK_AUTH_TEST_URL);
      assert.equal(options?.method, HttpMethod.Post);
      assert.deepEqual(options?.headers, {
        [AUTHORIZATION_HEADER]: `Bearer ${SLACK_USER_TOKEN}`,
      });
      return new Response(answer, { status: HttpStatus.OK });
    },
  );
}

test("the slack validator posts auth.test with Bearer and answers healthy for ok true", async (t) => {
  const fetch = mockAuthTest(t, SLACK_OK_ANSWER);
  const status = await INTAKE_PLATFORMS.slack.probe!(
    { key: SLACK_USER_TOKEN },
    null,
    background,
  );
  assert.equal(status, ResourceStatus.Healthy);
  assert.equal(fetch.mock.callCount(), ONE_CALL);
});

test("the slack validator answers unhealthy for ok false", async (t) => {
  const fetch = mockAuthTest(t, SLACK_NOT_OK_ANSWER);
  const status = await INTAKE_PLATFORMS.slack.probe!(
    { key: SLACK_USER_TOKEN },
    null,
    background,
  );
  assert.equal(status, ResourceStatus.Unhealthy);
  assert.equal(fetch.mock.callCount(), ONE_CALL);
});
