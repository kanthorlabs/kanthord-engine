import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurationSchemaOf,
  GITHUB_RESOURCE_PATTERN,
  resourceIdentityOf,
} from "./configuration.ts";
import { InboundKind, InboundPlatform, ResourceKind } from "./contract.ts";

const RESOURCE = "acme/app";
const IDENTITY = "repository:github:acme/app";
const CONVERSATION_IDENTITY = "conversation:github:acme/app";
const OTHER_RESOURCE_KIND = "issue";

test("both kinds of github answer the resource schema", () => {
  for (const kind of Object.values(InboundKind)) {
    const schema = configurationSchemaOf(kind, InboundPlatform.GitHub);
    assert.deepEqual(
      schema.parse({
        resource_kind: ResourceKind.Repository,
        resource: RESOURCE,
      }),
      { resource_kind: ResourceKind.Repository, resource: RESOURCE },
    );
  }
});

test("a configuration with an extra field refuses", () => {
  const schema = configurationSchemaOf(
    InboundKind.Webhook,
    InboundPlatform.GitHub,
  );
  assert.equal(
    schema.safeParse({
      resource_kind: ResourceKind.Repository,
      resource: RESOURCE,
      extra: 1,
    }).success,
    false,
  );
});

test("a resource without a slash, with a colon or with whitespace refuses", () => {
  for (const resource of ["acme", "acme/app/x", "a:b/app", "acme/a pp", "/app"])
    assert.ok(!GITHUB_RESOURCE_PATTERN.test(resource), resource);
});

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

test("an absent resource_kind and another value refuse for both kinds", () => {
  for (const kind of Object.values(InboundKind)) {
    const schema = configurationSchemaOf(kind, InboundPlatform.GitHub);
    assert.equal(schema.safeParse({ resource: RESOURCE }).success, false);
    assert.equal(
      schema.safeParse({
        resource_kind: OTHER_RESOURCE_KIND,
        resource: RESOURCE,
      }).success,
      false,
    );
  }
});
