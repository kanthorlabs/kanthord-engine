import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { decode } from "hono/jwt";
import { IdentityKind } from "../../kernel/caller.ts";
import {
  deriveClientSecret,
  generateSlotJWT,
  SLOT_TOKEN_LIFETIME,
} from "./jwt.ts";

const AUTH_VERSION = 1;
const NEXT_AUTH_VERSION = 2;

const KEY_BYTES = 32;
const SUBJECT = "client_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_SUBJECT = "client_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SLOT_CLIENT = "client_identity_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SLOT_NUMBER = 2;
const SLOT_NAME = "server slot 2";
const SLOT_BINDING = "coder-main";
const SLOT_RESOURCE_IDENTITY = "worker:kanthord:coder-main";
const SLOT_LIFETIME_SECONDS = 60;
const MILLISECONDS_PER_SECOND = 1000;

test("client secrets use HKDF-SHA256 and bind to the master key and machine subject", () => {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const secret = deriveClientSecret(masterKey, AUTH_VERSION, SUBJECT);
  const expected = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKey, "base64"),
      Buffer.alloc(0),
      `worker/client-secret/v1/${SUBJECT}`,
      KEY_BYTES,
    ),
  ).toString("base64");
  assert.equal(secret, expected);
  assert.equal(deriveClientSecret(masterKey, AUTH_VERSION, SUBJECT), secret);
  assert.notEqual(
    deriveClientSecret(masterKey, AUTH_VERSION, OTHER_SUBJECT),
    secret,
  );
  assert.notEqual(
    deriveClientSecret(
      randomBytes(KEY_BYTES).toString("base64"),
      AUTH_VERSION,
      SUBJECT,
    ),
    secret,
  );
  assert.equal(Buffer.from(secret, "base64").length, KEY_BYTES);
  assert.equal(Buffer.from(secret, "base64").toString("base64"), secret);
});

test("an auth version increment changes every client secret", () => {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const next = deriveClientSecret(masterKey, NEXT_AUTH_VERSION, SUBJECT);
  assert.notEqual(next, deriveClientSecret(masterKey, AUTH_VERSION, SUBJECT));
  assert.equal(
    next,
    Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(masterKey, "base64"),
        Buffer.alloc(0),
        `worker/client-secret/v${NEXT_AUTH_VERSION}/${SUBJECT}`,
        KEY_BYTES,
      ),
    ).toString("base64"),
  );
});

test("a slot token names the slot, lives 60 seconds and is minted for each call", async () => {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const slot = {
    clientId: SLOT_CLIENT,
    projectId: PROJECT_ID,
    bindingName: SLOT_BINDING,
    slot: SLOT_NUMBER,
  };
  const first = await generateSlotJWT(masterKey, AUTH_VERSION, slot);
  const second = await generateSlotJWT(masterKey, AUTH_VERSION, slot);
  const claims = decode(first.token).payload;
  assert.equal(SLOT_TOKEN_LIFETIME, SLOT_LIFETIME_SECONDS);
  assert.equal(claims.exp! - claims.iat!, SLOT_LIFETIME_SECONDS);
  assert.equal(first.expiresAt, claims.exp! * MILLISECONDS_PER_SECOND);
  assert.equal(claims.sub, SLOT_CLIENT);
  assert.equal(claims.name, SLOT_NAME);
  assert.equal(claims.kind, IdentityKind.Client);
  assert.equal(claims.project_id, PROJECT_ID);
  assert.equal(claims.resource_identity, SLOT_RESOURCE_IDENTITY);
  assert.notEqual(claims.jti, decode(second.token).payload.jti);
  await assert.rejects(
    generateSlotJWT(masterKey, AUTH_VERSION, { ...slot, clientId: "x" }),
  );
});
