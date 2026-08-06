import type { NodeKind } from "./state.ts";

export type SubmittedPathErrorCode =
  | "path-not-under-plan"
  | "path-not-markdown"
  | "path-empty-segment"
  | "path-dot-segment"
  | "path-backslash"
  | "path-nul"
  | "path-absolute"
  | "path-not-scalar"
  | "path-kind-mismatch";

export class SubmittedPathError extends Error {
  readonly code: SubmittedPathErrorCode;

  constructor(code: SubmittedPathErrorCode, message: string) {
    super(message);
    this.name = "SubmittedPathError";
    this.code = code;
  }
}

export type SubmittedPathShape = Readonly<{
  kind: NodeKind;
  initiativeDirectory: string;
  objectiveDirectory: string | null;
}>;

export function parseSubmittedPath(path: string): SubmittedPathShape {
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      path,
    )
  ) {
    throw new SubmittedPathError(
      "path-not-scalar",
      "the path holds an unpaired surrogate",
    );
  }
  if (path.includes("\0")) {
    throw new SubmittedPathError("path-nul", "the path holds a NUL byte");
  }
  if (path.includes("\\")) {
    throw new SubmittedPathError(
      "path-backslash",
      "the path holds a backslash",
    );
  }
  if (path.startsWith("/")) {
    throw new SubmittedPathError("path-absolute", "the path is absolute");
  }
  const segments = path.split("/");
  if (segments.includes("")) {
    throw new SubmittedPathError(
      "path-empty-segment",
      "the path holds an empty segment",
    );
  }
  if (segments.includes(".") || segments.includes("..")) {
    throw new SubmittedPathError(
      "path-dot-segment",
      "the path holds a dot segment",
    );
  }
  if (segments[0] !== "plan") {
    throw new SubmittedPathError(
      "path-not-under-plan",
      "the path is not under plan/",
    );
  }
  if (!path.endsWith(".md")) {
    throw new SubmittedPathError(
      "path-not-markdown",
      "the path does not end in .md",
    );
  }
  const last = segments[segments.length - 1]!;
  if (segments.length === 3 && last === "initiative.md") {
    return {
      kind: "initiative",
      initiativeDirectory: segments[1]!,
      objectiveDirectory: null,
    };
  }
  if (segments.length === 4 && last === "objective.md") {
    return {
      kind: "objective",
      initiativeDirectory: segments[1]!,
      objectiveDirectory: segments[2]!,
    };
  }
  if (segments.length === 4 && last !== "initiative.md") {
    return {
      kind: "task",
      initiativeDirectory: segments[1]!,
      objectiveDirectory: segments[2]!,
    };
  }
  throw new SubmittedPathError(
    "path-kind-mismatch",
    "the segment layout does not name a node kind",
  );
}

export function comparePaths(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function resolveRelativePath(
  fromDirectory: string,
  reference: string,
): string | null {
  const segments = fromDirectory.split("/");
  for (const part of reference.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (segments.length <= 1) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

export function derivedParentPath(path: string): string | null {
  const parsed = parseSubmittedPath(path);
  if (parsed.kind === "initiative") return null;
  if (parsed.kind === "objective") {
    return `plan/${parsed.initiativeDirectory}/initiative.md`;
  }
  return `plan/${parsed.initiativeDirectory}/${parsed.objectiveDirectory}/objective.md`;
}
