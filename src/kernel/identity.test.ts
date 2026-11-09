import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIdentity,
  IDENTITY_SUFFIX_LENGTH,
  identitySchema,
  identityTime,
  ulidSchema,
} from "./identity.ts";

const suffix = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("entity identities retain a stable prefix and canonical uppercase ULID", () => {
  for (const prefix of ["request", "project", "mission", "worker_binding"]) {
    const schema = identitySchema(prefix);
    const first = createIdentity(prefix);
    const second = createIdentity(prefix);
    assert.equal(schema.parse(first), first);
    assert.equal(schema.parse(second), second);
    assert.notEqual(first, second);
    assert.ok(first.startsWith(`${prefix}_`));
    assert.equal(first.length, prefix.length + IDENTITY_SUFFIX_LENGTH);
    assert.ok(ulidSchema.safeParse(first.slice(prefix.length + 1)).success);
    assert.equal(schema.parse(`${prefix}_${suffix}`), `${prefix}_${suffix}`);
  }
});

test("prefix declarations reject empty, non-word and unsafe regular-expression input", () => {
  for (const prefix of [
    "",
    "Project",
    "project_",
    "_project",
    "worker__binding",
    "worker-binding",
    "project1",
    ".*",
    "project\n",
  ]) {
    assert.throws(() => identitySchema(prefix), assert.AssertionError);
    assert.throws(() => createIdentity(prefix), assert.AssertionError);
  }
});

test("an identity time lies in the creation window and needs a ULID suffix", () => {
  const before = Date.now();
  const time = identityTime(createIdentity("execution"));
  const after = Date.now();
  assert.ok(time >= before && time <= after);
  assert.throws(() => identityTime("execution_invalid"));
});
