import {
  constants,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Diagnostic } from "./errors.ts";

export const FileKind = { File: "file", Directory: "directory" } as const;
export type FileKind = (typeof FileKind)[keyof typeof FileKind];
export const FILE_NOT_FOUND = "ENOENT";
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

function validate(stats: Stats, path: string, kind: FileKind) {
  const mode =
    kind === FileKind.File ? PRIVATE_FILE_MODE : PRIVATE_DIRECTORY_MODE;
  if (
    (kind === FileKind.File ? !stats.isFile() : !stats.isDirectory()) ||
    (stats.mode & 0o7777) !== mode ||
    stats.uid !== process.getuid?.()
  ) {
    throw new Diagnostic(
      "system.files.invalid_permissions",
      `${path}: expected an owned ${kind} with mode ${mode.toString(8)} on a POSIX filesystem.`,
    );
  }
}

export function audit(path: string, kind: FileKind, optional = false): boolean {
  try {
    validate(lstatSync(path), path, kind);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND && optional)
      return false;
    if (error instanceof Diagnostic) throw error;
    throw new Diagnostic(
      "system.files.inspect_failed",
      `${path}: cannot inspect ${kind}.`,
    );
  }
}

export function ensureDirectory(path: string): void {
  if (!audit(path, FileKind.Directory, true)) {
    try {
      mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    } catch {
      throw new Diagnostic(
        "system.files.create_failed",
        `${path}: cannot create directory.`,
      );
    }
    audit(path, FileKind.Directory);
  }
}

export function openPrivate(path: string, flags: number): number {
  audit(path, FileKind.File, !!(flags & constants.O_CREAT));
  let fd: number | undefined;
  try {
    fd = openSync(path, flags | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    validate(fstatSync(fd), path, FileKind.File);
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof Diagnostic) throw error;
    throw new Diagnostic(
      "system.files.open_failed",
      `${path}: cannot open private file.`,
    );
  }
}

export function readPrivate(path: string): string {
  const fd = openPrivate(path, constants.O_RDONLY);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Same-directory publication: init never overwrites; explicit replacements are atomic. */
export function writePrivate(
  path: string,
  content: string,
  replace = false,
): void {
  ensureDirectory(dirname(path));
  if (replace) audit(path, FileKind.File, true);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openPrivate(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
  } catch (error) {
    if (error instanceof Diagnostic) throw error;
    throw new Diagnostic(
      "system.files.publish_failed",
      `${path}: cannot publish file; init requires an absent destination.`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_NOT_FOUND) throw error;
    }
  }
}
