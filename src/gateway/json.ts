import { canonicalJSON } from "../shared/json.ts";
import { GatewayError } from "./errors.ts";

const MAX_JSON_DEPTH = 128;
const JsonToken = {
  Escape: "\\",
  Quote: '"',
  ObjectStart: "{",
  ObjectEnd: "}",
  ArrayStart: "[",
  ArrayEnd: "]",
  MemberSeparator: ":",
  ValueSeparator: ",",
} as const;

/** Validate the text before JSON.parse can discard duplicate member names. */
export function parseJSON(source: string): unknown {
  let index = 0;
  const invalid = () => {
    throw new GatewayError(
      400,
      "gateway.request.invalid_json",
      "Expected valid JSON with unique object members.",
    );
  };
  const whitespace = () => {
    while (/[\t\n\r ]/.test(source[index] ?? "!")) index++;
  };
  function string(): string {
    const start = index++;
    while (index < source.length) {
      if (source[index] === JsonToken.Escape) {
        index += 2;
        continue;
      }
      if (source[index++] === JsonToken.Quote)
        return JSON.parse(source.slice(start, index)) as string;
    }
    return invalid();
  }
  function value(depth: number): void {
    if (depth > MAX_JSON_DEPTH) invalid();
    whitespace();
    if (source[index] === JsonToken.Quote) {
      string();
      return;
    }
    if (
      source[index] === JsonToken.ObjectStart ||
      source[index] === JsonToken.ArrayStart
    ) {
      const object = source[index++] === JsonToken.ObjectStart;
      const end = object ? JsonToken.ObjectEnd : JsonToken.ArrayEnd;
      const keys = new Set<string>();
      whitespace();
      if (source[index] === end) {
        index++;
        return;
      }
      for (;;) {
        whitespace();
        if (object) {
          if (source[index] !== JsonToken.Quote) invalid();
          const key = string();
          if (keys.has(key)) invalid();
          keys.add(key);
          whitespace();
          if (source[index++] !== JsonToken.MemberSeparator) invalid();
        }
        value(depth + 1);
        whitespace();
        if (source[index] === end) {
          index++;
          return;
        }
        if (source[index++] !== JsonToken.ValueSeparator) invalid();
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        source.slice(index),
      );
    if (!match) invalid();
    index += match![0].length;
  }
  try {
    value(0);
    whitespace();
    if (index !== source.length) invalid();
    const parsed: unknown = JSON.parse(source);
    canonicalJSON(parsed);
    return parsed;
  } catch {
    return invalid();
  }
}
