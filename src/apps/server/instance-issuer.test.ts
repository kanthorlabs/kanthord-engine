import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createIdentity } from "../../kernel/identity.ts";
import { instanceClientIdentity, instanceIssuer } from "./instance-issuer.ts";

const KEY_BYTES = 32;
const AUTH_VERSION = 1;
const NEXT_AUTH_VERSION = 2;
const GENERATION = 3;
const RESOURCE = "worker:kanthord:coder";
const CLIENT_IDENTITY = /^client_identity_[0-9A-HJKMNP-TV-Z]{26}$/;

test("the client identity of a server instance for one binding is the instance derivation", () => {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const instanceId = createIdentity("worker_instance");
  const projectId = createIdentity("project");
  const identity = instanceIssuer(masterKey, AUTH_VERSION).clientIdentity(
    instanceId,
    projectId,
    RESOURCE,
    GENERATION,
  );
  assert.match(identity, CLIENT_IDENTITY);
  assert.equal(
    identity,
    instanceClientIdentity(
      masterKey,
      instanceId,
      projectId,
      RESOURCE,
      GENERATION,
    ),
  );
  assert.notEqual(
    identity,
    instanceIssuer(masterKey, AUTH_VERSION).clientIdentity(
      createIdentity("worker_instance"),
      projectId,
      RESOURCE,
      GENERATION,
    ),
  );
});

test("the client identity stays stable across a restart and an increment of gateway.auth.version", () => {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const instanceId = createIdentity("worker_instance");
  const projectId = createIdentity("project");
  const derive = (authVersion: number) =>
    instanceIssuer(masterKey, authVersion).clientIdentity(
      instanceId,
      projectId,
      RESOURCE,
      GENERATION,
    );
  const first = derive(AUTH_VERSION);
  assert.equal(derive(AUTH_VERSION), first);
  assert.equal(derive(NEXT_AUTH_VERSION), first);
});
