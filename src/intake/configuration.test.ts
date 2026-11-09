import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurationSchemaOf,
  inboundCredentialPlatform,
  inboundSupported,
  resourceIdentityOf,
} from "./configuration.ts";
import { InboundKind, InboundPlatform, ResourceKind } from "./contract.ts";
import { Platform } from "./credential-platform.ts";
import {
  SLACK_RESOURCE_IDENTITY,
  SLACK_TEAM_ID,
} from "./slack-test-support.ts";

const RESOURCE = "acme/app";
const IDENTITY = "repository:github:acme/app";
const CONVERSATION_IDENTITY = "conversation:github:acme/app";

test("a repository gives the repository identity and a conversation gives the conversation identity", () => {
  assert.equal(
    resourceIdentityOf(InboundPlatform.GitHub, {
      resource_kind: ResourceKind.Repository,
      resource: RESOURCE,
    }),
    IDENTITY,
  );
  assert.equal(
    resourceIdentityOf(InboundPlatform.GitHub, {
      resource_kind: ResourceKind.Conversation,
      resource: RESOURCE,
    }),
    CONVERSATION_IDENTITY,
  );
});

test("slack takes the webhook kind alone with a team id of a conversation", () => {
  assert.equal(
    inboundSupported(InboundKind.Webhook, InboundPlatform.Slack),
    true,
  );
  assert.equal(
    inboundSupported(InboundKind.Poll, InboundPlatform.Slack),
    false,
  );
  const configuration = {
    resource_kind: ResourceKind.Conversation,
    resource: SLACK_TEAM_ID,
  };
  assert.deepEqual(
    configurationSchemaOf(InboundKind.Webhook, InboundPlatform.Slack).parse(
      configuration,
    ),
    configuration,
  );
  assert.equal(
    resourceIdentityOf(InboundPlatform.Slack, configuration),
    SLACK_RESOURCE_IDENTITY,
  );
});

test("only a slack webhook and a github poll name a credential platform", () => {
  assert.equal(
    inboundCredentialPlatform(InboundKind.Webhook, InboundPlatform.Slack),
    Platform.SlackSigningSecret,
  );
  assert.equal(
    inboundCredentialPlatform(InboundKind.Poll, InboundPlatform.GitHub),
    InboundPlatform.GitHub,
  );
  for (const platform of [InboundPlatform.GitHub, InboundPlatform.Jira])
    assert.equal(
      inboundCredentialPlatform(InboundKind.Webhook, platform),
      null,
    );
});
