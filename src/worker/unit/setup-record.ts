import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { writePrivate } from "../../kernel/files.ts";

export const SETUP_RECORD_FILE = "kanthord-setup.json";
const GIT_DIRECTORY = ".git";
const PARENT_SEGMENT = "..";
const SEGMENT_SEPARATOR = "/";

export const setupRecordSchema = z.strictObject({
  digest: z.string(),
  roots: z.array(z.string()),
});
export type SetupRecord = z.infer<typeof setupRecordSchema>;

function recordPath(directory: string): string {
  return join(directory, GIT_DIRECTORY, SETUP_RECORD_FILE);
}

function validRoot(directory: string, root: string): boolean {
  if (!root || root.startsWith(SEGMENT_SEPARATOR)) return false;
  const segments = root.split(SEGMENT_SEPARATOR);
  if (segments.includes(PARENT_SEGMENT) || segments.includes(GIT_DIRECTORY))
    return false;
  const inside = relative(directory, resolve(directory, root));
  return (
    !!inside &&
    !isAbsolute(inside) &&
    !inside.split(SEGMENT_SEPARATOR).includes(PARENT_SEGMENT)
  );
}

export function validRoots(
  directory: string,
  roots: readonly string[],
): boolean {
  return roots.every((root) => validRoot(directory, root));
}

export function readSetupRecord(directory: string): SetupRecord | null {
  const path = recordPath(directory);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const parsed = setupRecordSchema.safeParse(value);
  if (!parsed.success || !validRoots(directory, parsed.data.roots)) return null;
  return parsed.data;
}

export function writeSetupRecord(directory: string, record: SetupRecord): void {
  writePrivate(recordPath(directory), JSON.stringify(record), true);
}

export function removeSetupRecord(directory: string): void {
  rmSync(recordPath(directory), { force: true });
}

export function nextRoots(
  kept: readonly string[],
  before: readonly string[],
  after: readonly string[],
): string[] {
  const earlier = new Set(before);
  const listed = new Set(after);
  return [
    ...new Set([
      ...after.filter((path) => !earlier.has(path)),
      ...kept.filter((path) => listed.has(path)),
    ]),
  ].sort();
}
