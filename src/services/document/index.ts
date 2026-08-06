export type Frontmatter = Readonly<{
  frontmatter: unknown;
  body: string;
}>;

export type DocumentErrorCode =
  | "document-frontmatter-missing"
  | "document-frontmatter-unparsable"
  | "document-frontmatter-not-a-map";

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;

  constructor(code: DocumentErrorCode, message: string) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
  }
}

export interface DocumentReader {
  read(text: string): Frontmatter;
}
