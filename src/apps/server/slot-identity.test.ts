import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { CLIENT_IDENTITY_PREFIX } from "../../kernel/caller.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { slotClientIdentity } from "./slot-identity.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const RESOURCE = "worker:kanthord:coder-main";
const GENERATION = 1760000000000;
const SLOT_COUNT = 64;

test("a slot client identity is stable, valid and distinct for each input", () => {
  const masterKey = randomBytes(32).toString("base64");
  const base = slotClientIdentity(
    masterKey,
    PROJECT_ID,
    RESOURCE,
    GENERATION,
    0,
  );
  assert.equal(
    slotClientIdentity(masterKey, PROJECT_ID, RESOURCE, GENERATION, 0),
    base,
  );
  assert.ok(identitySchema(CLIENT_IDENTITY_PREFIX).safeParse(base).success);
  const others = [
    slotClientIdentity(masterKey, PROJECT_ID, RESOURCE, GENERATION, 1),
    slotClientIdentity(masterKey, PROJECT_ID, RESOURCE, GENERATION + 1, 0),
    slotClientIdentity(
      masterKey,
      PROJECT_ID,
      "worker:kanthord:other",
      GENERATION,
      0,
    ),
    slotClientIdentity(masterKey, OTHER_PROJECT_ID, RESOURCE, GENERATION, 0),
    slotClientIdentity(
      randomBytes(32).toString("base64"),
      PROJECT_ID,
      RESOURCE,
      GENERATION,
      0,
    ),
  ];
  assert.equal(new Set([base, ...others]).size, others.length + 1);
});

test("every slot number yields a valid client identity", () => {
  const masterKey = randomBytes(32).toString("base64");
  const schema = identitySchema(CLIENT_IDENTITY_PREFIX);
  const seen = new Set<string>();
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const identity = slotClientIdentity(
      masterKey,
      PROJECT_ID,
      RESOURCE,
      GENERATION,
      slot,
    );
    assert.ok(schema.safeParse(identity).success, identity);
    seen.add(identity);
  }
  assert.equal(seen.size, SLOT_COUNT);
});
