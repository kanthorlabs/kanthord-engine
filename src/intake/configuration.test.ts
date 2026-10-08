import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GITHUB_RESOURCE_PATTERN,
  configurationSchemaOf,
  resourceIdentityOf,
} from "./configuration.ts";
import { InboundKind, InboundPlatform } from "./contract.ts";

const RESOURCE = "acme/app";
const IDENTITY = "repository:github:acme/app";

test("both kinds of github answer the resource schema", () => {
  for (const kind of Object.values(InboundKind)) {
    const schema = configurationSchemaOf(kind, InboundPlatform.GitHub);
    assert.deepEqual(schema.parse({ resource: RESOURCE }), {
      resource: RESOURCE,
    });
  }
});

test("a configuration with an extra field refuses", () => {
  const schema = configurationSchemaOf(
    InboundKind.Webhook,
    InboundPlatform.GitHub,
  );
  assert.equal(
    schema.safeParse({ resource: RESOURCE, extra: 1 }).success,
    false,
  );
});

test("a resource without a slash, with a colon or with whitespace refuses", () => {
  for (const resource of ["acme", "acme/app/x", "a:b/app", "acme/a pp", "/app"])
    assert.ok(!GITHUB_RESOURCE_PATTERN.test(resource), resource);
});

test("the resource identity carries the repository form", () => {
  assert.equal(
    resourceIdentityOf(InboundPlatform.GitHub, { resource: RESOURCE }),
    IDENTITY,
  );
});
