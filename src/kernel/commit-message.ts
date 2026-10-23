import assert from "node:assert/strict";

export const CommitType = {
  Feat: "feat",
  Fix: "fix",
  Docs: "docs",
  Style: "style",
  Refactor: "refactor",
  Test: "test",
  Chore: "chore",
} as const;
export type CommitType = (typeof CommitType)[keyof typeof CommitType];
export const DEFAULT_COMMIT_TYPE: CommitType = CommitType.Feat;
export const COMMIT_HEADER_MAX_LENGTH = 100;
const HEADER_SEPARATOR = ": ";
const LINE_SEPARATOR = "\n";
const PARAGRAPH_SEPARATOR = "\n\n";
const HEADER_LINE = 1;
const SPACE = " ";
const NO_TEXT = "";
const FIRST_LETTER = 0;
const AFTER_FIRST_LETTER = 1;
const WHITESPACE = /\s+/g;
const FINAL_FULL_STOP = /\.$/;
const UNIT_ID = /^[^\s:]+$/;
const COMMIT_HEADER = new RegExp(
  `^(${Object.values(CommitType).join("|")})(\\([^()\\s]+\\))?: \\S.*$`,
);

export function commitTypeOf(value: CommitType | undefined): CommitType {
  return value ?? DEFAULT_COMMIT_TYPE;
}

export function isCommitHeader(header: string): boolean {
  return (
    header.length <= COMMIT_HEADER_MAX_LENGTH && COMMIT_HEADER.test(header)
  );
}

export function isCommitMessage(message: string): boolean {
  const [header] = message.split(LINE_SEPARATOR, HEADER_LINE);
  return header !== undefined && isCommitHeader(header);
}

export function commitHeader(type: CommitType, subject: string): string {
  const prefix = `${type}${HEADER_SEPARATOR}`;
  const line = subject.replace(WHITESPACE, SPACE).trim();
  const lowered =
    line.charAt(FIRST_LETTER).toLowerCase() + line.slice(AFTER_FIRST_LETTER);
  const cut = lowered
    .slice(FIRST_LETTER, COMMIT_HEADER_MAX_LENGTH - prefix.length)
    .trimEnd()
    .replace(FINAL_FULL_STOP, NO_TEXT)
    .trimEnd();
  const header = `${prefix}${cut}`;
  assert.ok(isCommitHeader(header), `Invalid commit header: ${header}`);
  return header;
}

export function commitMessage(
  type: CommitType,
  subject: string,
  unitId: string,
): string {
  assert.match(unitId, UNIT_ID);
  return `${commitHeader(type, subject)}${PARAGRAPH_SEPARATOR}${unitId}`;
}
