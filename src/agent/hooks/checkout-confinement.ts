import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
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
import { getToolEntry } from "../catalog.ts";

const HOME_PREFIX = "~";
const HOME_DIRECTORY_PREFIX = "~/";
const REFERENCE_PREFIX = "@";
const FILE_URL = /^file:\/\//;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const PLAIN_SPACE = " ";
const MERIDIEM_SUFFIX = / (AM|PM)\./gi;
const NARROW_NO_BREAK_SPACE = "\u202F";
const STRAIGHT_QUOTE = /'/g;
const CURLY_QUOTE = "\u2019";
const DECOMPOSED_FORM = "NFD";
const PARENT_SEGMENT = "..";
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
const NO_RELATIVE = "";

export interface Confinement {
  cwd: string;
  roots: readonly string[];
}

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

function expanded(path: string): string {
  const spaced = path.replace(UNICODE_SPACES, PLAIN_SPACE);
  const named = spaced.startsWith(REFERENCE_PREFIX)
    ? spaced.slice(REFERENCE_PREFIX.length)
    : spaced;
  if (named === HOME_PREFIX) return homedir();
  if (named.startsWith(HOME_DIRECTORY_PREFIX))
    return join(homedir(), named.slice(HOME_DIRECTORY_PREFIX.length));
  return FILE_URL.test(named) ? fileURLToPath(named) : named;
}

function candidates(cwd: string, path: string): string[] | null {
  let target: string;
  try {
    target = resolve(cwd, expanded(path));
  } catch {
    return null;
  }
  const decomposed = target.normalize(DECOMPOSED_FORM);
  return [
    target,
    target.replace(MERIDIEM_SUFFIX, `${NARROW_NO_BREAK_SPACE}$1.`),
    decomposed,
    target.replace(STRAIGHT_QUOTE, CURLY_QUOTE),
    decomposed.replace(STRAIGHT_QUOTE, CURLY_QUOTE),
  ];
}

function leaves(confinement: Confinement, path: string): boolean {
  const targets = candidates(confinement.cwd, path);
  if (targets === null) return true;
  const roots = confinement.roots
    .map(resolveNearest)
    .filter((root) => root !== null);
  return [...new Set(targets)].some((target) => {
    const resolved = resolveNearest(target);
    return resolved === null || !roots.some((root) => inside(root, resolved));
  });
}

export function checkoutConfinement(confinement: Confinement): InlineExtension {
  assert.ok(isAbsolute(confinement.cwd));
  assert.ok(confinement.roots.length);
  assert.ok(confinement.roots.every((root) => isAbsolute(root)));
  return (pi) => {
    pi.on("tool_call", (event) => {
      const entry = getToolEntry(event.toolName);
      if (!entry)
        return {
          block: true,
          reason: `The tool ${event.toolName} has no location rule in this session.`,
        };
      const input = event.input as Record<string, unknown>;
      const refused = entry.locations
        .map((field) => input[field])
        .find(
          (value) =>
            value !== undefined &&
            (!isString(value) || leaves(confinement, value)),
        );
      if (refused === undefined) return undefined;
      return {
        block: true,
        reason: `The path ${String(refused)} is outside the checkout. Use a relative path inside the checkout.`,
      };
    });
  };
}
