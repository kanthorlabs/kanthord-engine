import type { Dirent, Stats } from "node:fs";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const LOCK_FILE_NAMES = [
  "FETCH_HEAD.lock",
  "HEAD.lock",
  "commit-graph-chain.lock",
  "commit-graph.lock",
  "config.lock",
  "gc.pid",
  "index.lock",
  "packed-refs.lock",
  "shallow.lock",
] as const;

export const LOCK_SUBTREES = ["objects", "refs"] as const;
export const STAGING_PREFIX = ".staging-";
export const KEY_PREFIX = "key-";
export const HELPER_LOG_PATTERN = /^helper-[0-9a-f-]+\.log$/;
export const KEPT_KEY_FILES = [
  "credential-helper.sh",
  "ssh-wrapper.sh",
] as const;

export type SweepBoundary = Readonly<{
  kind: "bare-home" | "workspace";
  root: string;
  repositoryId: string;
}>;

export type SweepHomeInput = Readonly<{
  boundaries: readonly SweepBoundary[];
  keyDirectory: string;
}>;

export type SweepRemoval = Readonly<{
  path: string;
  class: "lock" | "staging" | "key-material";
  repositoryId: string | null;
}>;

export type SweepRefusal = Readonly<{
  path: string;
  class: "lock" | "staging" | "key-material";
  repositoryId: string | null;
  reason:
    | "outside-boundary"
    | "not-a-regular-file"
    | "not-a-directory"
    | "symlink-on-path";
}>;

export type SweepHomeReport = Readonly<{
  removed: readonly SweepRemoval[];
  refused: readonly SweepRefusal[];
}>;

type SweepClass = SweepRemoval["class"];

type Candidate = Readonly<{
  path: string;
  class: SweepClass;
  repositoryId: string | null;
  boundaryRoot: string;
}>;

export async function sweepHome(
  input: SweepHomeInput,
): Promise<SweepHomeReport> {
  const candidates = collectCandidates(input);
  const removed: SweepRemoval[] = [];
  const refused: SweepRefusal[] = [];
  const resolvedRoots = new Map<string, string>();
  for (const candidate of candidates) {
    const reason = refuseReason(candidate, resolvedRoots);
    if (reason === null) {
      removeEntry(candidate);
      removed.push({
        path: candidate.path,
        class: candidate.class,
        repositoryId: candidate.repositoryId,
      });
    } else {
      refused.push({
        path: candidate.path,
        class: candidate.class,
        repositoryId: candidate.repositoryId,
        reason,
      });
    }
  }
  removed.sort(compareByPath);
  refused.sort(compareByPath);
  return { removed, refused };
}

function collectCandidates(input: SweepHomeInput): Candidate[] {
  const candidates: Candidate[] = [];
  const seenStaging = new Set<string>();
  for (const boundary of input.boundaries) {
    const root =
      boundary.kind === "workspace"
        ? join(boundary.root, ".git")
        : boundary.root;
    candidates.push(...collectLockCandidates(root, boundary.repositoryId));
    const stagingRoot = dirname(boundary.root);
    for (const candidate of collectStagingCandidates(
      stagingRoot,
      boundary.repositoryId,
    )) {
      if (seenStaging.has(candidate.path)) {
        continue;
      }
      seenStaging.add(candidate.path);
      candidates.push(candidate);
    }
  }
  candidates.push(...collectKeyCandidates(input.keyDirectory));
  return candidates;
}

function collectLockCandidates(
  root: string,
  repositoryId: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const name of LOCK_FILE_NAMES) {
    const path = join(root, name);
    if (lstatOrNull(path) !== null) {
      candidates.push({
        path,
        class: "lock",
        repositoryId,
        boundaryRoot: root,
      });
    }
  }
  for (const subtree of LOCK_SUBTREES) {
    const subtreeRoot = join(root, subtree);
    if (lstatOrNull(subtreeRoot) === null) {
      continue;
    }
    const stack: string[] = [subtreeRoot];
    while (stack.length > 0) {
      const directory = stack.pop() as string;
      const stat = lstatOrNull(directory);
      if (stat === null) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        candidates.push({
          path: directory,
          class: "lock",
          repositoryId,
          boundaryRoot: root,
        });
        continue;
      }
      if (!stat.isDirectory()) {
        continue;
      }
      const entries = readdirOrNull(directory) ?? [];
      entries.sort((left, right) =>
        Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
      );
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const entryStat = lstatOrNull(path);
        if (entryStat === null) {
          continue;
        }
        if (entry.name.endsWith(".lock") || entryStat.isSymbolicLink()) {
          candidates.push({
            path,
            class: "lock",
            repositoryId,
            boundaryRoot: root,
          });
        }
        if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
          stack.push(path);
        }
      }
    }
  }
  return candidates;
}

function collectStagingCandidates(
  parent: string,
  repositoryId: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  const entries = readdirOrNull(parent);
  if (entries === null) {
    return candidates;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(STAGING_PREFIX)) {
      continue;
    }
    const path = join(parent, entry.name);
    if (lstatOrNull(path) === null) {
      continue;
    }
    candidates.push({
      path,
      class: "staging",
      repositoryId,
      boundaryRoot: parent,
    });
  }
  return candidates;
}

function collectKeyCandidates(keyDirectory: string): Candidate[] {
  const candidates: Candidate[] = [];
  const entries = readdirOrNull(keyDirectory);
  if (entries === null) {
    return candidates;
  }
  for (const entry of entries) {
    if (KEPT_KEY_FILES.some((kept) => kept === entry.name)) {
      continue;
    }
    if (
      !entry.name.startsWith(KEY_PREFIX) &&
      !HELPER_LOG_PATTERN.test(entry.name)
    ) {
      continue;
    }
    const path = join(keyDirectory, entry.name);
    if (lstatOrNull(path) === null) {
      continue;
    }
    candidates.push({
      path,
      class: "key-material",
      repositoryId: null,
      boundaryRoot: keyDirectory,
    });
  }
  return candidates;
}

function refuseReason(
  candidate: Candidate,
  resolvedRoots: Map<string, string>,
): SweepRefusal["reason"] | null {
  if (hasSymlinkOnPath(candidate.boundaryRoot, candidate.path)) {
    return "symlink-on-path";
  }
  let resolvedRoot = resolvedRoots.get(candidate.boundaryRoot);
  if (resolvedRoot === undefined) {
    resolvedRoot = realpathSync(candidate.boundaryRoot);
    resolvedRoots.set(candidate.boundaryRoot, resolvedRoot);
  }
  const resolvedParent = realpathSync(dirname(candidate.path));
  const fromRoot = relative(resolvedRoot, resolvedParent);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    return "outside-boundary";
  }
  const stat = lstatOrNull(candidate.path);
  if (stat === null) {
    return null;
  }
  if (candidate.class === "staging") {
    if (!stat.isDirectory()) {
      return "not-a-directory";
    }
  } else if (!stat.isFile()) {
    return "not-a-regular-file";
  }
  return null;
}

function hasSymlinkOnPath(
  boundaryRoot: string,
  candidatePath: string,
): boolean {
  const fromRoot = relative(boundaryRoot, candidatePath);
  if (fromRoot === "") {
    return false;
  }
  let current = boundaryRoot;
  for (const part of fromRoot.split(sep)) {
    if (part === "") {
      continue;
    }
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (stat !== null && stat.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

function removeEntry(candidate: Candidate): void {
  if (candidate.class === "staging") {
    rmSync(candidate.path, { recursive: true, force: true });
  } else {
    rmSync(candidate.path, { force: true });
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

function readdirOrNull(directory: string): Dirent[] | null {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}

function compareByPath(
  left: Readonly<{ path: string }>,
  right: Readonly<{ path: string }>,
): number {
  return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}
