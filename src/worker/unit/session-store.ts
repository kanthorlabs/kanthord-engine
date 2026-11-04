import assert from "node:assert/strict";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PI_DIRECTORY_NAME } from "../../agent/pi.ts";
import { ensureDirectory, FILE_NOT_FOUND } from "../../kernel/files.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { isObject } from "../../kernel/values.ts";
import {
  entryIdentitySchema,
  SESSION_ENTRY_FULL_MAX_BYTES,
  spanIdSchema,
} from "../../tracking/contract.ts";
import {
  type FootprintItem,
  type SessionRead,
  SessionReadOutcome,
  type SessionReadResult,
  SessionRemoval,
  type SessionRemovalResult,
} from "../contract.ts";

const SESSIONS_DIRECTORY = "sessions";
const EXECUTION_DIRECTORY = "execution";
const SESSION_FILE_SUFFIX = ".jsonl";
const SESSION_NAME_SEPARATOR = "_";
const SYMLINK_LOOP = "ELOOP";
const READ_CHUNK_BYTES = 65536;
const LINE_FEED = 0x0a;
const START = 0;
const NEEDLE_OVERLAP = 1;
const LINE_FEED_BYTES = 1;
const NOT_FOUND_INDEX = -1;
const SINGLE_LINK = 1;
const NO_BYTES = 0;
const SESSION_FILE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function sessionRootOf(dataDirectory: string): string {
  return join(dataDirectory, PI_DIRECTORY_NAME, SESSIONS_DIRECTORY);
}

export function executionSessionRoot(dataDirectory: string): string {
  return join(sessionRootOf(dataDirectory), EXECUTION_DIRECTORY);
}

export function executionSessionDirectory(
  sessionRoot: string,
  executionId: string,
): string {
  const directory = join(
    sessionRoot,
    identitySchema("execution").parse(executionId),
  );
  ensureDirectory(directory);
  return directory;
}

class Unreadable extends Error {}

interface LineScan {
  resolved: Record<string, unknown> | null;
  tooLarge: number | null;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === FILE_NOT_FOUND;
}

async function directoryStats(path: string): Promise<Stats | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Unreadable();
  }
  if (!stats.isDirectory()) throw new Unreadable();
  return stats;
}

async function requireSameDirectory(path: string, kept: Stats): Promise<void> {
  const stats = await directoryStats(path);
  if (!stats || stats.dev !== kept.dev || stats.ino !== kept.ino)
    throw new Unreadable();
}

async function openSessionFile(path: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, SESSION_FILE_OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === FILE_NOT_FOUND || code === SYMLINK_LOOP) return null;
    throw new Unreadable();
  }
  return handle;
}

function parsedLine(
  line: Buffer,
  read: SessionRead,
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(value) || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  return entry.id === read.entry_id && entry.type === read.entry_type
    ? entry
    : null;
}

async function scanLines(
  handle: FileHandle,
  size: number,
  read: SessionRead,
  signal: AbortSignal,
): Promise<LineScan> {
  const needle = Buffer.from(`"id":"${read.entry_id}"`, "utf8");
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let oversized = false;
  let matched = false;
  let tail = Buffer.alloc(START);
  let tooLarge: number | null = null;
  const search = (segment: Buffer) => {
    const window = Buffer.concat([tail, segment]);
    if (window.includes(needle)) matched = true;
    tail = window.subarray(
      Math.max(START, window.length - needle.length + NEEDLE_OVERLAP),
    );
  };
  const append = (segment: Buffer) => {
    lineBytes += segment.length;
    if (oversized) return search(segment);
    if (lineBytes <= SESSION_ENTRY_FULL_MAX_BYTES)
      return void parts.push(Buffer.from(segment));
    oversized = true;
    for (const part of parts) search(part);
    parts = [];
    search(segment);
  };
  const finish = (): Record<string, unknown> | null => {
    const entry = oversized ? null : parsedLine(Buffer.concat(parts), read);
    if (oversized && matched && tooLarge === null) tooLarge = lineBytes;
    parts = [];
    lineBytes = 0;
    oversized = false;
    matched = false;
    tail = Buffer.alloc(START);
    return entry;
  };
  let position = START;
  while (position < size) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      chunk,
      START,
      Math.min(READ_CHUNK_BYTES, size - position),
      position,
    );
    if (bytesRead === START) break;
    position += bytesRead;
    let start = START;
    for (;;) {
      const end = chunk.indexOf(LINE_FEED, start);
      if (end === NOT_FOUND_INDEX || end >= bytesRead) break;
      append(chunk.subarray(start, end));
      const entry = finish();
      if (entry) return { resolved: entry, tooLarge };
      start = end + LINE_FEED_BYTES;
    }
    if (start < bytesRead) append(chunk.subarray(start, bytesRead));
  }
  const entry = finish();
  return { resolved: entry, tooLarge };
}

export async function readSessionFileEntry(
  root: string,
  read: SessionRead,
  signal: AbortSignal,
  options: { beforeOpen?: () => void } = {},
): Promise<SessionReadResult> {
  assert.ok(identitySchema("execution").safeParse(read.execution_id).success);
  assert.ok(spanIdSchema.safeParse(read.session_id).success);
  assert.ok(entryIdentitySchema.safeParse(read.entry_id).success);
  signal.throwIfAborted();
  const executions = join(root, EXECUTION_DIRECTORY);
  const directory = join(executions, read.execution_id);
  try {
    const executionsStats = await directoryStats(executions);
    const directoryStatsKept = executionsStats
      ? await directoryStats(directory)
      : null;
    if (!executionsStats || !directoryStatsKept)
      return { outcome: SessionReadOutcome.SessionAbsent };
    const suffix = `${SESSION_NAME_SEPARATOR}${read.session_id}${SESSION_FILE_SUFFIX}`;
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) =>
        name.endsWith(suffix),
      );
    } catch (error) {
      if (isMissing(error))
        return { outcome: SessionReadOutcome.SessionAbsent };
      throw new Unreadable();
    }
    if (names.length === START)
      return { outcome: SessionReadOutcome.SessionAbsent };
    options.beforeOpen?.();
    let tooLarge: number | null = null;
    for (const name of names) {
      signal.throwIfAborted();
      const handle = await openSessionFile(join(directory, name));
      if (!handle) continue;
      try {
        const stats = await handle.stat().catch(() => {
          throw new Unreadable();
        });
        if (!stats.isFile()) continue;
        await requireSameDirectory(executions, executionsStats);
        await requireSameDirectory(directory, directoryStatsKept);
        const scan = await scanLines(handle, stats.size, read, signal).catch(
          (error: unknown) => {
            if (signal.aborted) throw error;
            throw new Unreadable();
          },
        );
        if (scan.resolved)
          return { outcome: SessionReadOutcome.Resolved, entry: scan.resolved };
        tooLarge ??= scan.tooLarge;
      } finally {
        await handle.close();
      }
    }
    return tooLarge === null
      ? { outcome: SessionReadOutcome.EntryAbsent }
      : { outcome: SessionReadOutcome.TooLarge, bytes: tooLarge };
  } catch (error) {
    if (error instanceof Unreadable)
      return { outcome: SessionReadOutcome.Unreadable };
    throw error;
  }
}

interface TrustedTotal {
  bytes: number;
  newest_at: number;
}

async function trustedTotal(
  directory: string,
  kept: Stats,
  seen: Set<string>,
  signal: AbortSignal,
): Promise<TrustedTotal | null> {
  return walkTrusted(directory, kept, seen, signal).catch((error: unknown) => {
    if (signal.aborted) throw error;
    return null;
  });
}

async function walkTrusted(
  directory: string,
  kept: Stats,
  seen: Set<string>,
  signal: AbortSignal,
): Promise<TrustedTotal | null> {
  let bytes = 0;
  let newest = kept.mtimeMs;
  const pending = [directory];
  while (pending.length) {
    signal.throwIfAborted();
    const path = pending.pop()!;
    for (const name of await readdir(path)) {
      const stats = await lstat(join(path, name));
      if (stats.isSymbolicLink()) return null;
      if (stats.isDirectory()) {
        pending.push(join(path, name));
        continue;
      }
      if (!stats.isFile()) continue;
      newest = Math.max(newest, stats.mtimeMs);
      if (stats.nlink > SINGLE_LINK) {
        const identity = `${stats.dev}:${stats.ino}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      bytes += stats.size;
    }
  }
  const after = await lstat(directory).catch(() => null);
  if (!after || after.dev !== kept.dev || after.ino !== kept.ino) return null;
  return { bytes, newest_at: Math.floor(newest) };
}

interface TrustedExecution {
  directory: string;
  kept: Stats;
}

function isTrusted(
  found: TrustedExecution | SessionRemoval,
): found is TrustedExecution {
  return isObject(found);
}

async function trustedExecution(
  sessionRoot: string,
  executionId: string,
): Promise<TrustedExecution | SessionRemoval> {
  const executions = join(sessionRoot, EXECUTION_DIRECTORY);
  const directory = join(
    executions,
    identitySchema("execution").parse(executionId),
  );
  try {
    if (!(await directoryStats(executions))) return SessionRemoval.Absent;
    const kept = await directoryStats(directory);
    return kept ? { directory, kept } : SessionRemoval.Absent;
  } catch (error) {
    if (error instanceof Unreadable) return SessionRemoval.Unreadable;
    throw error;
  }
}

export async function executionSessionItems(
  sessionRoot: string,
  signal: AbortSignal,
): Promise<FootprintItem[]> {
  const executions = join(sessionRoot, EXECUTION_DIRECTORY);
  const root = await directoryStats(executions).catch((error: unknown) => {
    if (error instanceof Unreadable)
      throw new Error("The execution session root is not a directory.");
    throw error;
  });
  if (!root) return [];
  const seen = new Set<string>();
  const items: FootprintItem[] = [];
  for (const name of await readdir(executions)) {
    signal.throwIfAborted();
    if (!identitySchema("execution").safeParse(name).success) continue;
    const found = await trustedExecution(sessionRoot, name);
    if (!isTrusted(found)) continue;
    const total = await trustedTotal(found.directory, found.kept, seen, signal);
    if (total)
      items.push({
        key: name,
        bytes: total.bytes,
        modified_at: total.newest_at,
      });
  }
  return items;
}

export async function removeExecutionSession(
  sessionRoot: string,
  executionId: string,
  signal: AbortSignal,
): Promise<SessionRemovalResult> {
  const found = await trustedExecution(sessionRoot, executionId);
  if (!isTrusted(found)) return { removal: found, bytes: NO_BYTES };
  const total = await trustedTotal(
    found.directory,
    found.kept,
    new Set(),
    signal,
  );
  if (!total) return { removal: SessionRemoval.Unreadable, bytes: NO_BYTES };
  await rm(found.directory, { recursive: true, force: true });
  return { removal: SessionRemoval.Removed, bytes: total.bytes };
}
