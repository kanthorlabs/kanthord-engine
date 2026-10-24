import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isString } from "../../kernel/values.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
const HOME_PREFIX = "~";
const PARENT_SEGMENT = "..";
const SEGMENT_SEPARATOR = /[\\/]/;
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
const NO_RELATIVE = "";

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

function leaves(root: string, path: string): boolean {
  if (isAbsolute(path) || path.startsWith(HOME_PREFIX)) return true;
  if (path.split(SEGMENT_SEPARATOR).includes(PARENT_SEGMENT)) return true;
  const resolved = resolveNearest(join(root, path));
  return resolved === null || !inside(root, resolved);
}

export function checkoutConfinement(root: string): InlineExtension {
  assert.ok(isAbsolute(root));
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (!FILE_TOOLS.has(event.toolName)) return undefined;
      const { path } = event.input as { path?: unknown };
      if (!isString(path)) return undefined;
      const realRoot = realpathSync(root);
      if (!leaves(realRoot, path)) return undefined;
      return {
        block: true,
        reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
      };
    });
  };
}
