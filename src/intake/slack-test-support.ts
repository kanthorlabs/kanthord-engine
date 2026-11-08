import type { TestContext } from "node:test";
import { isString } from "../kernel/values.ts";
import { createHmac } from "node:crypto";

export const SLACK_TEAM_ID = "T01ABCDEF";
export const SLACK_RESOURCE_IDENTITY = `conversation:slack:${SLACK_TEAM_ID}`;
export const SLACK_USER_TOKEN = "test_private-slack-user-token";
export const SLACK_SIGNING_SECRET = "test_private-slack-signing-secret";
export const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
export const SLACK_OK_ANSWER = JSON.stringify({ ok: true });
export const SLACK_NOT_OK_ANSWER = JSON.stringify({
  ok: false,
  error: "invalid_auth",
});
export const SLACK_OTHER_TEAM_ID = "T09ZZZZZZ";
export const SLACK_CHANNEL = "C01ABCDEF";
export const SLACK_THREAD_TS = "1700000000.000100";
export const SLACK_REPLY_TS = "1700000100.123456";
export const SLACK_REPLY_MS = 1700000100123;
export const SLACK_USER_ID = "U01ABCDEF";
export const SLACK_REPLY_TEXT = "looks good to me";
export const SLACK_EVENT_ID = "Ev01ABCDEF";
export const SLACK_MESSAGE_EVENT = "message";
export const SLACK_CHALLENGE =
  "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";
export const SLACK_UPDATE_KEY = `slack_message:${SLACK_TEAM_ID}:${SLACK_CHANNEL}:${SLACK_REPLY_TS}`;
export const SLACK_PERMALINK = `https://slack.com/archives/${SLACK_CHANNEL}/p1700000100123456?thread_ts=${SLACK_THREAD_TS}&cid=${SLACK_CHANNEL}`;
export const SLACK_SIGNATURE_HEADER_NAME = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER_NAME = "x-slack-request-timestamp";

export function slackMessage(overrides: object = {}): object {
  return {
    type: SLACK_MESSAGE_EVENT,
    channel: SLACK_CHANNEL,
    user: SLACK_USER_ID,
    text: SLACK_REPLY_TEXT,
    ts: SLACK_REPLY_TS,
    thread_ts: SLACK_THREAD_TS,
    ...overrides,
  };
}

export function slackEventCallback(
  event: object = slackMessage(),
  envelope: object = {},
): object {
  return {
    type: "event_callback",
    team_id: SLACK_TEAM_ID,
    event_id: SLACK_EVENT_ID,
    event,
    ...envelope,
  };
}

export function slackBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), "utf8"));
}

export const SLACK_REPLY_DELIVERY_TEXT = JSON.stringify(slackEventCallback());
export const SLACK_URL_VERIFICATION_TEXT = JSON.stringify({
  type: "url_verification",
  challenge: SLACK_CHALLENGE,
});
export const SLACK_PARENT_DELIVERY_TEXT = JSON.stringify(
  slackEventCallback(slackMessage({ ts: SLACK_THREAD_TS })),
);

export function slackTimestamp(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

export function slackSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

export const SLACK_API_ORIGIN = "https://slack.com/api";
export const SLACK_REPLIES_URL = `${SLACK_API_ORIGIN}/conversations.replies?channel=${SLACK_CHANNEL}&ts=${SLACK_THREAD_TS}&limit=200`;
export const SLACK_POST_URL = `${SLACK_API_ORIGIN}/chat.postMessage`;
export const SLACK_TOKEN_ACCOUNT_ID = "U09TOKEN01";
export const SLACK_SECOND_REPLY_TS = "1700000200.000300";
export const SLACK_SECOND_UPDATE_KEY = `slack_message:${SLACK_TEAM_ID}:${SLACK_CHANNEL}:${SLACK_SECOND_REPLY_TS}`;
export const SLACK_REPLY_LISTED_EVENT = "reply_listed";
const SLACK_OK_STATUS = 200;

export interface SlackRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

export function slackResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function slackOkResponse(body: object = {}): Response {
  return slackResponse(SLACK_OK_STATUS, { ok: true, ...body });
}

export function slackErrorResponse(error: string): Response {
  return slackResponse(SLACK_OK_STATUS, { ok: false, error });
}

export function slackListedMessage(overrides: object = {}): object {
  return {
    type: SLACK_MESSAGE_EVENT,
    user: SLACK_USER_ID,
    text: SLACK_REPLY_TEXT,
    ts: SLACK_REPLY_TS,
    thread_ts: SLACK_THREAD_TS,
    ...overrides,
  };
}

export function slackParentMessage(): object {
  return slackListedMessage({
    text: "the parent",
    ts: SLACK_THREAD_TS,
    reply_count: 2,
  });
}

export function slackRepliesPage(...messages: object[]): object {
  return { messages, has_more: false };
}

export function slackPostedMessage(ts: string, user?: string): object {
  return {
    channel: SLACK_CHANNEL,
    ts,
    message: { type: SLACK_MESSAGE_EVENT, ts, ...(user ? { user } : {}) },
  };
}

export function mockSlackFetch(
  t: TestContext,
  answer: (request: SlackRequest) => Response | Promise<Response>,
): { requests: SlackRequest[] } {
  const requests: SlackRequest[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const request: SlackRequest = {
        method: init?.method ?? "GET",
        url: String(url),
        authorization: headers.get("authorization"),
        contentType: headers.get("content-type"),
        body: isString(init?.body) ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      return answer(request);
    },
  );
  return { requests };
}
