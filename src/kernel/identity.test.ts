import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIdentity,
  identitySchema,
  ulidSchema,
  ULID_LENGTH,
  IDENTITY_SUFFIX_LENGTH,
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

test("identity validation rejects missing or wrong prefixes and noncanonical ULIDs", () => {
  const schema = identitySchema("project");
  for (const invalid of [
    suffix,
    `mission_${suffix}`,
    `Project_${suffix}`,
    `project__${suffix}`,
    `project_${suffix.toLowerCase()}`,
    `project_8${suffix.slice(1)}`,
    ...["I", "L", "O", "U"].map(
      (letter) => `project_${suffix.slice(0, -1)}${letter}`,
    ),
    `project_${suffix.slice(1)}`,
    `project_${suffix}0`,
    `project_${suffix}\n`,
    `project_${suffix}\r\n`,
    ` project_${suffix}`,
    "",
    null,
    123,
  ]) {
    assert.equal(schema.safeParse(invalid).success, false, String(invalid));
    assert.throws(() => schema.parse(invalid));
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

test("the separate bare ULID scalar preserves protocol contracts without admitting entity IDs", () => {
  assert.equal(ulidSchema.parse(suffix), suffix);
  assert.equal(
    ulidSchema.parse("7ZZZZZZZZZZZZZZZZZZZZZZZZZ").length,
    ULID_LENGTH,
  );
  for (const invalid of [
    suffix.toLowerCase(),
    `request_${suffix}`,
    `${suffix}\n`,
    `8${suffix.slice(1)}`,
  ]) {
    assert.equal(ulidSchema.safeParse(invalid).success, false);
    assert.throws(() => ulidSchema.parse(invalid));
  }
});
