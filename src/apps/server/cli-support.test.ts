import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";
import { temporary } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { environment, generateMachineToken, kanthord } from "./cli-support.ts";

const KEY_BYTES = 32;
const SUCCESS = 0;
const NO_STDERR = "";
const CLIENT_KIND = "client";
const PRIVATE_MODE = 0o600;
const MODE_MASK = 0o777;

test("machine issuance helper preserves group claims and independently derives private secrets", async (t) => {
  const env = environment(temporary(t));
  const input = {
    env,
    masterKey: randomBytes(KEY_BYTES).toString("base64"),
    projectId: createIdentity("project"),
    bindingName: "test-harness",
    name: "test_client",
  };
  const first = generateMachineToken(input);
  const second = generateMachineToken(input);
  assert.equal(Buffer.from(first.client_secret, "base64").length, KEY_BYTES);
  assert.equal(Buffer.from(second.client_secret, "base64").length, KEY_BYTES);
  assert.ok(first.client_secret !== second.client_secret);
  assert.equal(
    statSync(join(env.XDG_CONFIG_HOME!, "issuance.yaml")).mode & MODE_MASK,
    PRIVATE_MODE,
  );
  const inspected = await kanthord(["jwt", "inspect", first.token], env);
  assert.equal(inspected.code, SUCCESS);
  assert.equal(inspected.stderr, NO_STDERR);
  const documents = parseAllDocuments(inspected.stdout);
  assert.ok(documents.every((document) => !document.errors.length));
  const claims = documents[0]!.toJSON();
  assert.equal(claims.kind, CLIENT_KIND);
  assert.equal(claims.project_id, input.projectId);
  assert.equal(
    claims.resource_identity,
    `worker:kanthord:${input.bindingName}`,
  );
  assert.equal(claims.name, input.name);
  assert.equal(claims.binding, undefined);
});
