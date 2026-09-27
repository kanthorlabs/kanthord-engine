import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { Diagnostic } from "../../kernel/errors.ts";
import { ULID_LENGTH } from "../../kernel/identity.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  detectDuplicateKeys,
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFile,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const INVALID_PATH = "cli.file.invalid_path";
const NOT_FOUND = "cli.file.not_found";
const NOT_REGULAR = "cli.file.not_regular";
const NOT_OBJECT = "cli.file.not_object";
const DUPLICATE_KEY = "cli.file.duplicate_key";
const NOT_JSON = "cli.file.not_json";
const INVALID_ENCODING = "cli.file.encoding_invalid";
const INVALID_SCHEMA = "cli.file.schema_invalid";
const INVALID_PERMISSIONS = "system.files.invalid_permissions";
const INVALID_KEY = "cli.idempotency_key.invalid";
const BAD_INT = "cli.test.bad_int";
const DUPLICATE_OPTION = "cli.option.duplicate";
const FAILURE_CODE = "cli.test.failure";
const INDETERMINATE_CODE = "cli.test.indeterminate";
const TOKEN_CODE = "cli.test.token";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const ONE = 1;
const FIRST_VALUE = "a";
const TOKEN = "jwt";
const PRIVATE_MODE = 0o600;
const PUBLIC_MODE = 0o644;
const SUCCESS_STATUS = 200;
const FAILURE_STATUS = 400;

function diagnosticCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Diagnostic && error.code === code;
}

test("JSON file checks path, existence, type, and object shape", (t) => {
  const directory = temporary(t);
  assert.throws(() => readJsonFile("-"), diagnosticCode(INVALID_PATH));
  assert.throws(
    () => readJsonFile(join(directory, "missing.json")),
    diagnosticCode(NOT_FOUND),
  );
  assert.throws(() => readJsonFile(directory), diagnosticCode(NOT_REGULAR));
  const path = join(directory, "data.json");
  writeFileSync(path, '{"a":1}');
  assert.deepEqual(readJsonFile(path), { a: 1 });
  writeFileSync(path, "[1,2]");
  assert.throws(() => readJsonFile(path), diagnosticCode(NOT_OBJECT));
});

test("duplicate keys are detected at each object depth after escape decoding", (t) => {
  const path = join(temporary(t), "data.json");
  for (const content of [
    '{"a":1,"a":2}',
    '{"x":{"a":1,"a":2}}',
    '{"a":1,"\\u0061":2}',
    '{"a":1,"\\/":2,"/":3}',
  ]) {
    writeFileSync(path, content);
    assert.throws(() => readJsonFile(path), diagnosticCode(DUPLICATE_KEY));
  }
  detectDuplicateKeys('[{"a":1},{"a":2}]');
  detectDuplicateKeys('{"a":{"x":1},"b":{"x":2}}');
  detectDuplicateKeys('{"a":"\\\"a\\\"", "b": 2}');
  assert.throws(() => detectDuplicateKeys('{"a":'), diagnosticCode(NOT_JSON));
});

test("private files enforce permissions and public files reject invalid UTF-8", (t) => {
  const path = join(temporary(t), "private.json");
  writeFileSync(path, '{"a":1}', { mode: PUBLIC_MODE });
  chmodSync(path, PUBLIC_MODE);
  assert.throws(
    () => readJsonFile(path, true),
    diagnosticCode(INVALID_PERMISSIONS),
  );
  chmodSync(path, PRIVATE_MODE);
  assert.deepEqual(readJsonFile(path, true), { a: 1 });
  writeFileSync(path, Buffer.from([0xff]));
  assert.throws(() => readJsonFile(path), diagnosticCode(INVALID_ENCODING));
});

test("schema validation does not include secret input in diagnostics", (t) => {
  const path = join(temporary(t), "data.json");
  writeFileSync(path, '{"secret":"do-not-report"}');
  const schema = z.strictObject({ secret: z.number() });
  assert.throws(
    () => readJsonFileAs(path, schema),
    (error) =>
      error instanceof Diagnostic &&
      error.code === INVALID_SCHEMA &&
      !error.message.includes("do-not-report"),
  );
  writeFileSync(path, '{"secret":123}');
  assert.deepEqual(readJsonFileAs(path, schema), { secret: 123 });
});

test("idempotency key resolution", () => {
  assert.throws(
    () => resolveKey({ idempotencyKey: "not-a-ulid" }),
    diagnosticCode(INVALID_KEY),
  );
  assert.equal(resolveKey({ idempotencyKey: KEY }), KEY);
  assert.equal(resolveKey({}).length, ULID_LENGTH);
});

test("positive integer parser accepts decimal safe integers only", () => {
  assert.throws(() => parsePositiveInt("0", BAD_INT), diagnosticCode(BAD_INT));
  assert.equal(parsePositiveInt("1", BAD_INT), ONE);
  for (const value of [
    "1.5",
    "1e2",
    "+1",
    "-1",
    "Infinity",
    "9007199254740992",
    " 1",
    "01x",
  ])
    assert.throws(
      () => parsePositiveInt(value, BAD_INT),
      diagnosticCode(BAD_INT),
    );
});

test("single-use option rejects repeats", () => {
  assert.throws(
    () => singleUse("--endpoint")("a", "b"),
    diagnosticCode(DUPLICATE_OPTION),
  );
  assert.equal(singleUse("--endpoint")(FIRST_VALUE, undefined), FIRST_VALUE);
});

test("mutation results return data or include the retry key", () => {
  const completed: OperationResult<number> = {
    type: OperationResultType.Completed,
    status: SUCCESS_STATUS,
    data: 1,
  };
  const failure: OperationResult<number> = {
    type: OperationResultType.Failure,
    status: FAILURE_STATUS,
    error: {
      error: { code: FAILURE_CODE, message: "failed", details: null },
      requestId: "request_" + KEY,
    },
  };
  const indeterminate: OperationResult<number> = {
    type: OperationResultType.Indeterminate,
  };
  assert.equal(handleMutationResult(completed, INDETERMINATE_CODE, KEY), ONE);
  assert.throws(
    () => handleMutationResult(failure, INDETERMINATE_CODE, KEY),
    (error) =>
      error instanceof Diagnostic &&
      error.code === FAILURE_CODE &&
      error.message.includes(KEY),
  );
  assert.throws(
    () => handleMutationResult(indeterminate, INDETERMINATE_CODE, KEY),
    (error) =>
      error instanceof Diagnostic &&
      error.code === INDETERMINATE_CODE &&
      error.message.includes(KEY),
  );
});

test("read results return data, preserve server failures, and signal uncertainty", () => {
  const completed: OperationResult<number> = {
    type: OperationResultType.Completed,
    status: SUCCESS_STATUS,
    data: 1,
  };
  const failure: OperationResult<number> = {
    type: OperationResultType.Failure,
    status: FAILURE_STATUS,
    error: {
      error: { code: FAILURE_CODE, message: "failed", details: null },
      requestId: "request_" + KEY,
    },
  };
  const indeterminate: OperationResult<number> = {
    type: OperationResultType.Indeterminate,
  };
  assert.equal(handleReadResult(completed, INDETERMINATE_CODE), ONE);
  assert.throws(
    () => handleReadResult(failure, INDETERMINATE_CODE),
    diagnosticCode(FAILURE_CODE),
  );
  assert.throws(
    () => handleReadResult(indeterminate, INDETERMINATE_CODE),
    diagnosticCode(INDETERMINATE_CODE),
  );
});

test("requireToken rejects absent and blank tokens", () => {
  assert.throws(
    () => requireToken(undefined, TOKEN_CODE),
    diagnosticCode(TOKEN_CODE),
  );
  assert.throws(
    () => requireToken("  ", TOKEN_CODE),
    diagnosticCode(TOKEN_CODE),
  );
  const token: string | undefined = TOKEN;
  requireToken(token, TOKEN_CODE);
  assert.equal(token, TOKEN);
});
