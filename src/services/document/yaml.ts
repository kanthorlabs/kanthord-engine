import { parse } from "yaml";

import type { DocumentReader, Frontmatter } from "./index.ts";
import { DocumentError } from "./index.ts";

export class YamlDocumentReader implements DocumentReader {
  read(text: string): Frontmatter {
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (!normalized.startsWith("---\n")) {
      throw new DocumentError(
        "document-frontmatter-missing",
        "the document must begin with the three bytes --- followed by one LF",
      );
    }
    const afterOpener = normalized.slice(4);
    const closer = findClosingDelimiter(afterOpener);
    if (closer === null) {
      throw new DocumentError(
        "document-frontmatter-missing",
        "the frontmatter opener has no closing delimiter line holding exactly ---",
      );
    }
    const frontmatterText = afterOpener.slice(0, closer.lineStart);
    const body = afterOpener.slice(closer.bodyStart);

    let parsed: unknown;
    try {
      parsed = parse(frontmatterText, { schema: "core", version: "1.2" });
    } catch (error) {
      throw new DocumentError(
        "document-frontmatter-unparsable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new DocumentError(
        "document-frontmatter-not-a-map",
        "the frontmatter must parse to a map",
      );
    }
    return { frontmatter: parsed, body };
  }
}

function findClosingDelimiter(
  text: string,
): Readonly<{ lineStart: number; bodyStart: number }> | null {
  let index = 0;
  while (index <= text.length) {
    const newlineIndex = text.indexOf("\n", index);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    if (text.slice(index, lineEnd) === "---") {
      return {
        lineStart: index,
        bodyStart: newlineIndex === -1 ? lineEnd : lineEnd + 1,
      };
    }
    if (newlineIndex === -1) return null;
    index = newlineIndex + 1;
  }
  return null;
}
