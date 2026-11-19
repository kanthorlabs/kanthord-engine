import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../../kernel/values.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
]);
const HOME_PREFIX = "~";
const AT_PREFIX = "@";
const FILE_URL = /^file:\/\//;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const PARENT_SEGMENT = "..";
const SEGMENT_SEPARATOR = /[\\/]/;
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
const NO_RELATIVE = "";
const READ_TOOL = "read";
const SCREENSHOT_TIME = / (AM|PM)\./gi;
const NARROW_NO_BREAK_SPACE = "\u202F";
const STRAIGHT_QUOTE = /'/g;
const CURLY_QUOTE = "\u2019";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

function resolveNearest(path: string): string | null {
  const absent: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...absent.toReversed());
    } catch (error) {
      if (!ABSENT_CODES.has(errorCode(error) ?? "")) return null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    absent.push(basename(current));
    current = parent;
  }
}

function inside(root: string, path: string): boolean {
  const from = relative(root, path);
  return (
    from === NO_RELATIVE ||
    (from !== PARENT_SEGMENT &&
      !from.startsWith(PARENT_SEGMENT + sep) &&
      !isAbsolute(from))
  );
}

function normalized(path: string): string {
  const spaced = path.replace(UNICODE_SPACES, " ");
  const stripped = spaced.startsWith(AT_PREFIX) ? spaced.slice(1) : spaced;
  return FILE_URL.test(stripped) ? fileURLToPath(stripped) : stripped;
}

function readVariants(path: string): string[] {
  const decomposed = path.normalize("NFD");
  return [
    path,
    path.replace(SCREENSHOT_TIME, `${NARROW_NO_BREAK_SPACE}$1.`),
    decomposed,
    path.replace(STRAIGHT_QUOTE, CURLY_QUOTE),
    decomposed.replace(STRAIGHT_QUOTE, CURLY_QUOTE),
  ];
}

function leaves(root: string, raw: string, toolName: string): boolean {
  let path: string;
  try {
    path = normalized(raw);
  } catch {
    return true;
  }
  if (isAbsolute(path) || path.startsWith(HOME_PREFIX)) return true;
  if (path.split(SEGMENT_SEPARATOR).includes(PARENT_SEGMENT)) return true;
  const candidates = toolName === READ_TOOL ? readVariants(path) : [path];
  return candidates.some((candidate) => {
    const resolved = resolveNearest(join(root, candidate));
    return resolved === null || !inside(root, resolved);
  });
}

export function checkoutConfinement(root: string): InlineExtension {
  assert.ok(isAbsolute(root));
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (!FILE_TOOLS.has(event.toolName)) return undefined;
      const { path } = event.input as { path?: unknown };
      if (!isString(path)) return undefined;
      const realRoot = realpathSync(root);
      if (!leaves(realRoot, path, event.toolName)) return undefined;
      return {
        block: true,
        reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
      };
    });
  };
}
