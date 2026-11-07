import assert from "node:assert/strict";
import { knownMatcher, redactValue } from "../agent/sensitive-text.ts";
import { isString } from "../kernel/values.ts";

const TEXT_ENCODING = "utf8";

export function redactedText(text: string): string {
  const redacted = redactValue(text, knownMatcher());
  assert.ok(isString(redacted), "A redacted text is a text.");
  return redacted;
}

export function eventText(event: Uint8Array): string {
  return Buffer.from(event).toString(TEXT_ENCODING);
}
