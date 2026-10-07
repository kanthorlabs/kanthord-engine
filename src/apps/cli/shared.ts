import { readFileSync, statSync } from "node:fs";
import { ulid } from "ulid";
import { z } from "zod";
import { Diagnostic } from "../../kernel/errors.ts";
import { readPrivate } from "../../kernel/files.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { ValueType } from "../../kernel/values.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";

const INVALID_PATH = "cli.file.invalid_path";
const NOT_FOUND = "cli.file.not_found";
const NOT_REGULAR = "cli.file.not_regular";
const INVALID_ENCODING = "cli.file.encoding_invalid";
const NOT_JSON = "cli.file.not_json";
const DUPLICATE_KEY = "cli.file.duplicate_key";
const NOT_OBJECT = "cli.file.not_object";
const INVALID_SCHEMA = "cli.file.schema_invalid";
const INVALID_KEY = "cli.idempotency_key.invalid";
const DUPLICATE_OPTION = "cli.option.duplicate";
const STDIN = "-";
const OBJECT_START = "{";
const OBJECT_END = "}";
const ARRAY_START = "[";
const ARRAY_END = "]";
const COMMA = ",";
const QUOTE = '"';
const ESCAPE = "\\";
const STRING_START_INDEX = 0;
const POSITIVE_INT_FLOOR = 0;
const SCAN_STEP = 1;
const ESCAPE_SEQUENCE_LENGTH = 2;
const DECIMAL_DIGITS = /^[0-9]+$/;

type Frame = { keys: Set<string>; expectKey: boolean } | null;

function scanString(text: string, start: number): number {
  let end = start + SCAN_STEP;
  while (end < text.length) {
    if (text[end] === ESCAPE) {
      end += ESCAPE_SEQUENCE_LENGTH;
      continue;
    }
    if (text[end] === QUOTE) return end + SCAN_STEP;
    end++;
  }
  throw new Diagnostic(NOT_JSON, "invalid JSON string");
}

export function detectDuplicateKeys(text: string): void {
  try {
    JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Diagnostic(NOT_JSON, "invalid JSON document");
    throw error;
  }
  const stack: Frame[] = [];
  for (let index = STRING_START_INDEX; index < text.length; index++) {
    const char = text[index];
    if (char === OBJECT_START) stack.push({ keys: new Set(), expectKey: true });
    else if (char === ARRAY_START) stack.push(null);
    else if (char === OBJECT_END || char === ARRAY_END) stack.pop();
    else if (char === COMMA) {
      const frame = stack.at(-SCAN_STEP);
      if (frame) frame.expectKey = true;
    } else if (char === QUOTE) {
      const end = scanString(text, index);
      const frame = stack.at(-SCAN_STEP);
      if (frame?.expectKey) {
        const key: string = JSON.parse(text.slice(index, end));
        if (frame.keys.has(key)) throw new Diagnostic(DUPLICATE_KEY, key);
        frame.keys.add(key);
        frame.expectKey = false;
      }
      index = end - SCAN_STEP;
    }
  }
}

export function readTextFile(path: string, requirePrivate = false): string {
  if (path === STDIN)
    throw new Diagnostic(INVALID_PATH, "stdin is not accepted");
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) throw new Diagnostic(NOT_FOUND, `${path}: file not found`);
  if (!stat.isFile())
    throw new Diagnostic(NOT_REGULAR, `${path}: not a regular file`);
  if (requirePrivate) return readPrivate(path);
  const buffer = readFileSync(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    if (error instanceof TypeError)
      throw new Diagnostic(INVALID_ENCODING, `${path}: invalid UTF-8`);
    throw error;
  }
}

export function readJsonFile(path: string, requirePrivate = false): unknown {
  const text = readTextFile(path, requirePrivate);
  detectDuplicateKeys(text);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Diagnostic(NOT_JSON, "invalid JSON document");
    throw error;
  }
  if (raw === null || typeof raw !== ValueType.Object || Array.isArray(raw))
    throw new Diagnostic(NOT_OBJECT, `${path}: expected a JSON object`);
  return raw;
}

export function readJsonFileAs<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  requirePrivate = false,
): z.infer<S> {
  const raw = readJsonFile(path, requirePrivate);
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new Diagnostic(
      INVALID_SCHEMA,
      JSON.stringify(
        result.error.issues.map(({ path, code }) => ({ path, code })),
      ),
    );
  return result.data;
}

export function resolveKey(options: { idempotencyKey?: string }): string {
  if (options.idempotencyKey === undefined) return ulid();
  if (!ulidSchema.safeParse(options.idempotencyKey).success)
    throw new Diagnostic(INVALID_KEY, "invalid idempotency key");
  return options.idempotencyKey;
}

export function handleMutationResult<T>(
  result: OperationResult<T>,
  indeterminateCode: string,
  key: string,
): T {
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new Diagnostic(
      result.error.error.code,
      JSON.stringify({ ...result.error.error, idempotencyKey: key }),
    );
  throw new Diagnostic(
    indeterminateCode,
    "retry with --idempotency-key " + key,
  );
}

export function handleReadResult<T>(
  result: OperationResult<T>,
  indeterminateCode: string,
): T {
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new Diagnostic(
      result.error.error.code,
      JSON.stringify(result.error.error),
    );
  throw new Diagnostic(indeterminateCode, "retry the command");
}

export function requireToken(
  token: string | undefined,
  code: string,
): asserts token is string {
  if (!token?.trim()) throw new Diagnostic(code, "a token is required");
}

export function parsePositiveInt(value: string, code: string): number {
  const number = Number(value);
  if (
    !DECIMAL_DIGITS.test(value) ||
    !Number.isSafeInteger(number) ||
    number <= POSITIVE_INT_FLOOR
  )
    throw new Diagnostic(code, "not a positive integer");
  return number;
}

export function singleUse(
  name: string,
): (value: string, previous: string | undefined) => string {
  return (value, previous) => {
    if (previous !== undefined)
      throw new Diagnostic(DUPLICATE_OPTION, name + " may not be repeated");
    return value;
  };
}
