import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalLinkKind } from "../kernel/external-link.ts";
import { decodeSlackLinkUpdate, describeSlackEvent } from "./slack.ts";
import {
  SLACK_CHANNEL,
  SLACK_MESSAGE_EVENT,
  SLACK_OTHER_TEAM_ID,
  SLACK_PERMALINK,
  SLACK_REPLY_MS,
  SLACK_REPLY_TEXT,
  SLACK_REPLY_TS,
  SLACK_RESOURCE_IDENTITY,
  SLACK_TEAM_ID,
  SLACK_THREAD_TS,
  SLACK_UPDATE_KEY,
  SLACK_USER_ID,
  slackBytes,
  slackEventCallback,
  slackMessage,
} from "./slack-test-support.ts";

const OTHER_RESOURCE_IDENTITY = `conversation:slack:${SLACK_OTHER_TEAM_ID}`;
const APP_ID = "A01ABCDEF";
const BOT_ID = "B01ABCDEF";
const CHANNEL_JOIN = "channel_join";
const MESSAGE_CHANGED = "message_changed";
const MESSAGE_DELETED = "message_deleted";
const OTHER_EVENT = "reaction_added";

function decode(
  event: object,
  envelope: object = {},
  resourceIdentity: string = SLACK_RESOURCE_IDENTITY,
) {
  return decodeSlackLinkUpdate({
    resource_identity: resourceIdentity,
    event: slackBytes(slackEventCallback(event, envelope)),
    metadata: { event: SLACK_MESSAGE_EVENT },
  });
}

function describe(
  event: object,
  envelope: object = {},
  resource: string = SLACK_TEAM_ID,
) {
  return describeSlackEvent({
    resource,
    event: slackBytes(slackEventCallback(event, envelope)),
    metadata: { event: SLACK_MESSAGE_EVENT },
  });
}

test("a thread reply decodes to its link, key and facts", () => {
  assert.deepEqual(decode(slackMessage()), {
    external_link: {
      kind: ExternalLinkKind.SlackThread,
      resource_identity: SLACK_RESOURCE_IDENTITY,
      channel: SLACK_CHANNEL,
      thread_ts: SLACK_THREAD_TS,
    },
    update_key: SLACK_UPDATE_KEY,
    actor_id: SLACK_USER_ID,
    actor_automated: false,
    occurred_at: SLACK_REPLY_MS,
    mentions: [],
  });
});

test("a parent message, a message without a thread, message_changed, message_deleted and another event decode to null", () => {
  const refused = [
    slackMessage({ ts: SLACK_THREAD_TS }),
    slackMessage({ thread_ts: undefined }),
    slackMessage({ subtype: MESSAGE_CHANGED }),
    slackMessage({ subtype: MESSAGE_DELETED }),
    {
      type: SLACK_MESSAGE_EVENT,
      subtype: MESSAGE_CHANGED,
      channel: SLACK_CHANNEL,
      ts: SLACK_REPLY_TS,
      message: slackMessage(),
    },
    slackMessage({ type: OTHER_EVENT }),
  ];
  for (const event of refused)
    assert.equal(decode(event), null, JSON.stringify(event));
});

test("bot_id, app_id and another subtype answer actor_automated true", () => {
  for (const overrides of [
    { bot_id: BOT_ID },
    { app_id: APP_ID },
    { subtype: CHANNEL_JOIN },
  ])
    assert.equal(
      decode(slackMessage(overrides))?.actor_automated,
      true,
      JSON.stringify(overrides),
    );
});

test("a body of another team decodes to null", () => {
  assert.equal(decode(slackMessage(), { team_id: SLACK_OTHER_TEAM_ID }), null);
  assert.equal(decode(slackMessage(), {}, OTHER_RESOURCE_IDENTITY), null);
  assert.equal(decode(slackMessage(), { team_id: undefined }), null);
});

test("a body that is no event callback, no JSON or a repository identity decodes to null", () => {
  const input = {
    resource_identity: SLACK_RESOURCE_IDENTITY,
    metadata: { event: SLACK_MESSAGE_EVENT },
  };
  assert.equal(
    decodeSlackLinkUpdate({
      ...input,
      event: Buffer.from("not json"),
    }),
    null,
  );
  assert.equal(
    decodeSlackLinkUpdate({ ...input, event: slackBytes([]) }),
    null,
  );
  assert.equal(
    decodeSlackLinkUpdate({
      ...input,
      event: slackBytes(slackMessage()),
    }),
    null,
  );
  assert.equal(
    decodeSlackLinkUpdate({
      ...input,
      resource_identity: `repository:slack:${SLACK_TEAM_ID}`,
      event: slackBytes(slackEventCallback()),
    }),
    null,
  );
});

test("the description answers the user, the text, the permalink and the time", () => {
  assert.deepEqual(describe(slackMessage()), {
    author: SLACK_USER_ID,
    body: SLACK_REPLY_TEXT,
    url: SLACK_PERMALINK,
    occurred_at: SLACK_REPLY_MS,
  });
});

test("the description keeps the whole text and answers null for a parent, another team or another event", () => {
  const text = "x".repeat(5000);
  assert.equal(describe(slackMessage({ text }))?.body, text);
  assert.equal(describe(slackMessage({ ts: SLACK_THREAD_TS })), null);
  assert.equal(describe(slackMessage(), {}, SLACK_OTHER_TEAM_ID), null);
  assert.equal(describe(slackMessage({ type: OTHER_EVENT })), null);
  assert.equal(describe(slackMessage({ user: undefined })), null);
  assert.equal(describe(slackMessage({ subtype: MESSAGE_DELETED })), null);
});
