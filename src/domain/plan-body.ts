export const ACCEPTANCE_HEADING = "## Acceptance criteria";

export type BodySplit = Readonly<{
  instruction: string;
  acceptance: string | null;
}>;

export type BodySplitErrorCode =
  "acceptance-heading-duplicated" | "acceptance-heading-not-at-line-start";

export class BodySplitError extends Error {
  readonly code: BodySplitErrorCode;

  constructor(code: BodySplitErrorCode, message: string) {
    super(message);
    this.name = "BodySplitError";
    this.code = code;
  }
}

export function normalizeBody(body: string): string {
  const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return `${normalized.replace(/\n+$/, "")}\n`;
}

export function splitBody(body: string): BodySplit {
  let index = 0;
  let headingStart = -1;
  while (index <= body.length) {
    const newlineIndex = body.indexOf("\n", index);
    const lineEnd = newlineIndex === -1 ? body.length : newlineIndex;
    const line = body.slice(index, lineEnd);
    if (line === ACCEPTANCE_HEADING) {
      if (headingStart !== -1) {
        throw new BodySplitError(
          "acceptance-heading-duplicated",
          "the acceptance heading appears more than once",
        );
      }
      headingStart = index;
    } else if (/^## Acceptance criteria[ \t]+$/.test(line)) {
      throw new BodySplitError(
        "acceptance-heading-not-at-line-start",
        "the acceptance heading carries trailing whitespace",
      );
    }
    if (newlineIndex === -1) break;
    index = newlineIndex + 1;
  }
  if (headingStart === -1) {
    return { instruction: body, acceptance: null };
  }
  return {
    instruction: body.slice(0, headingStart),
    acceptance: body.slice(headingStart),
  };
}
