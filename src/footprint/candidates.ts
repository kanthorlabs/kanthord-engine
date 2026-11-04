import { createHash } from "node:crypto";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  type CleanableKind,
  CleanupRule,
  type CleanupRuleValue,
  DEFAULT_AGE_DAYS,
  FootprintErrorCode,
  KIND_RULES,
} from "./contract.ts";

const BASE64URL = "base64url";
const UTF8 = "utf8";
const CURSOR_SEPARATOR = ".";
const FINGERPRINT_LENGTH = 16;
const NOT_FOUND = -1;
const DECIMAL = /^(0|[1-9]\d*)$/;

export function ruleValue(
  name: CleanupRule,
  olderThanDays: number | undefined,
): CleanupRuleValue {
  return name === CleanupRule.OlderThan
    ? { name, older_than_days: olderThanDays ?? DEFAULT_AGE_DAYS }
    : { name };
}

export function defaultRule(kind: CleanableKind): CleanupRuleValue {
  return ruleValue(KIND_RULES[kind][0]!, DEFAULT_AGE_DAYS);
}

export function ruleSupported(
  kind: CleanableKind,
  rule: CleanupRuleValue,
): boolean {
  return KIND_RULES[kind].includes(rule.name);
}

function fingerprint(scope: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(scope))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

function cursorInvalid(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    FootprintErrorCode.CursorInvalid,
    "Invalid cursor.",
  );
}

export function encodeCursor(scope: unknown, position: string): string {
  return Buffer.from(
    `${fingerprint(scope)}${CURSOR_SEPARATOR}${position}`,
    UTF8,
  ).toString(BASE64URL);
}

export function decodeCursor(
  scope: unknown,
  cursor: string | undefined,
): string | null {
  if (cursor === undefined) return null;
  const text = Buffer.from(cursor, BASE64URL).toString(UTF8);
  const separator = text.indexOf(CURSOR_SEPARATOR);
  if (
    Buffer.from(text, UTF8).toString(BASE64URL) !== cursor ||
    separator === NOT_FOUND ||
    text.slice(0, separator) !== fingerprint(scope)
  )
    throw cursorInvalid();
  return text.slice(separator + 1);
}

export function offsetOf(position: string | null): number {
  if (position === null) return 0;
  if (!DECIMAL.test(position)) throw cursorInvalid();
  const offset = Number(position);
  if (!Number.isSafeInteger(offset)) throw cursorInvalid();
  return offset;
}
