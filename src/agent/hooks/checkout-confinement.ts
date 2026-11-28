import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
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
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
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

function realpathOrAbsent(path: string): string | null | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    return ABSENT_CODES.has(errorCode(error) ?? "") ? undefined : null;
  }
}

function resolveNearest(path: string): string | null {
  const absent: string[] = [];
  let current = path;
  for (;;) {
    const resolved = realpathOrAbsent(current);
    if (resolved === null) return null;
    if (resolved !== undefined) return join(resolved, ...absent.toReversed());
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
    path.replace(SCREENSHOT_TIME, `${NARROW_NO_BREAK_SPACE}$1.`),
    decomposed,
    path.replace(STRAIGHT_QUOTE, CURLY_QUOTE),
    decomposed.replace(STRAIGHT_QUOTE, CURLY_QUOTE),
  ];
}

function readTarget(path: string): string {
  if (existsSync(path)) return path;
  return (
    readVariants(path).find(
      (variant) => variant !== path && existsSync(variant),
    ) ?? path
  );
}

function relativePath(raw: string): string | null {
  let path: string;
  try {
    path = normalized(raw);
  } catch {
    return null;
  }
  return isAbsolute(path) || path.startsWith(HOME_PREFIX) ? null : path;
}

function resolvedTarget(
  root: string,
  path: string,
  toolName: string,
): string | null {
  const joined = resolve(root, path);
  return resolveNearest(toolName === READ_TOOL ? readTarget(joined) : joined);
}

function inReadRoot(readRoots: readonly string[], resolved: string): boolean {
  return readRoots.some((readRoot) => {
    const real = resolveNearest(readRoot);
    return real !== null && inside(real, resolved);
  });
}

interface Roots {
  root: string;
  readRoots: readonly string[];
}

function leaves(
  { root, readRoots }: Roots,
  raw: string,
  toolName: string,
): boolean {
  const path = relativePath(raw);
  if (path === null) return true;
  const resolved = resolvedTarget(root, path, toolName);
  if (resolved === null) return true;
  if (READ_ONLY_TOOLS.has(toolName) && inReadRoot(readRoots, resolved))
    return false;
  if (path.split(SEGMENT_SEPARATOR).includes(PARENT_SEGMENT)) return true;
  return !inside(realpathSync(root), resolved);
}

export function checkoutConfinement(
  root: string,
  readRoots: readonly string[] = [],
): InlineExtension {
  assert.ok(isAbsolute(root));
  assert.ok(readRoots.every((readRoot) => isAbsolute(readRoot)));
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (!FILE_TOOLS.has(event.toolName)) return undefined;
      const { path } = event.input as { path?: unknown };
      if (!isString(path)) return undefined;
      if (!leaves({ root, readRoots }, path, event.toolName)) return undefined;
      return {
        block: true,
        reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
      };
    });
  };
}
