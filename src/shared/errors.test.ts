import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  asError,
  CodedError,
  Diagnostic,
  diagnostic,
  errorCodeSchema,
} from "./errors.ts";
import { ContextCancelled, DeadlineExceeded } from "../context.ts";

import { ValueType } from "./values.ts";

const STRING_SCHEMA_TYPE = "string";
const SECRET_MARKER = "secret-marker";
const ExpectedDiagnostic = {
  MissingConfiguration: "cli.config.not_found: Configuration absent.",
  Unknown: "system.operation.unknown: Operation failed.",
} as const;
const ExpectedErrorCode = {
  Unknown: "system.operation.unknown",
  Cancelled: "system.context.cancelled",
  DeadlineExceeded: "system.context.deadline_exceeded",
} as const;
const validCodes = [
  "system.startup.unknown",
  "system.startup.permission_denied",
  "cli.config.not_found",
  "gateway.database.unavailable",
  "project.bindings.llm.openai.quota_exceeded",
];
const invalidCodes = [
  "",
  "UNKNOWN",
  "system.unknown",
  ".system.startup.unknown",
  "system..unknown",
  "system.startup.unknown.",
  "system.startup.UNKNOWN",
  "system.startup.permission-denied",
  "system.startup._unknown",
  "system.startup.unknown_",
  "system.startup.permission__denied",
  "system.startup.not found",
  "system.startup.unknown\n",
];

test("error codes require a namespace, components and a lower-case failure condition", () => {
  for (const code of validCodes) {
    assert.equal(errorCodeSchema.parse(code), code);
    assert.equal(new CodedError(code, "Failure.").code, code);
  }
  for (const code of invalidCodes) {
    assert.equal(errorCodeSchema.safeParse(code).success, false, code);
    assert.throws(() => new Diagnostic(code, "Failure."), /Invalid error code/);
  }
  assert.throws(() => new CodedError("system.startup.unknown", ""), /message/);
});

test("the published pattern enforces the same code grammar", () => {
  const schema = z.toJSONSchema(errorCodeSchema);
  assert.equal(schema.type, STRING_SCHEMA_TYPE);
  assert.equal(typeof schema.pattern, ValueType.String);
  const pattern = new RegExp(schema.pattern!);
  for (const code of validCodes) assert.ok(pattern.test(code), code);
  for (const code of invalidCodes)
    assert.equal(pattern.test(code), false, code);
});

test("diagnostics display scoped codes without exposing unexpected errors or causes", () => {
  const cause = new Error("secret-marker");
  const error = new Diagnostic(
    "cli.config.not_found",
    "Configuration absent.",
    {
      cause,
    },
  );
  assert.equal(error.cause, cause);
  assert.equal(diagnostic(error), ExpectedDiagnostic.MissingConfiguration);
  assert.equal(asError(error), error);
  assert.equal(asError(cause), cause);
  const unexpected = asError("secret-marker");
  assert.ok(unexpected instanceof CodedError);
  assert.equal(unexpected.code, ExpectedErrorCode.Unknown);
  assert.equal(unexpected.cause, SECRET_MARKER);
  for (const reason of [
    cause,
    unexpected,
    "secret-marker",
    { code: "SECRET" },
  ]) {
    assert.equal(diagnostic(reason), ExpectedDiagnostic.Unknown);
    assert.doesNotMatch(diagnostic(reason), /secret-marker|SECRET/);
  }
});

test("context errors identify cancellation and deadlines without changing their types", () => {
  const cancelled = new ContextCancelled();
  const expired = new DeadlineExceeded();
  assert.ok(cancelled instanceof Error);
  assert.ok(expired instanceof Error);
  assert.equal(cancelled.code, ExpectedErrorCode.Cancelled);
  assert.equal(expired.code, ExpectedErrorCode.DeadlineExceeded);
});
