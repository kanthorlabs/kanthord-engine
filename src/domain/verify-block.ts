import { z } from "zod";

import { comparePaths } from "./plan-path.ts";

const verifyPath = z.string().superRefine((path, context) => {
  const segments = path.split("/");
  const pathSegments = path.startsWith("/") ? segments.slice(1) : segments;
  const invalid =
    path.length === 0 ||
    !path.startsWith("/") ||
    path.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      path,
    ) ||
    path.includes("\\") ||
    path.endsWith("/") ||
    pathSegments.includes("") ||
    pathSegments.includes(".") ||
    pathSegments.includes("..");

  if (invalid) {
    context.addIssue({ code: "custom", message: "invalid verify path" });
  }
});

export const verifyBlock = z
  .strictObject({
    paths: z.array(verifyPath),
    commands: z.array(z.string()),
  })
  .superRefine((block, context) => {
    const seen = new Set<string>();
    for (const [index, path] of block.paths.entries()) {
      if (seen.has(path)) {
        context.addIssue({
          code: "custom",
          path: ["paths", index],
          message: "duplicate verify path",
        });
      }
      seen.add(path);
    }
  });

export type VerifyBlock = z.infer<typeof verifyBlock>;

export class VerifyBlockError extends Error {
  readonly code: "verify-json-malformed";

  constructor(message: string) {
    super(message);
    this.name = "VerifyBlockError";
    this.code = "verify-json-malformed";
  }
}

export function renderVerifyBlock(block: VerifyBlock): string {
  const paths = [...block.paths].sort(comparePaths);
  for (let index = 1; index < paths.length; index += 1) {
    if (paths[index - 1] === paths[index]) {
      throw new VerifyBlockError(`duplicate path: ${paths[index]}`);
    }
  }
  return JSON.stringify({ paths, commands: block.commands });
}

export function decodeVerifyBlock(
  text: string,
): { ok: true; block: VerifyBlock } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const result = verifyBlock.safeParse(parsed);
  if (!result.success) return { ok: false };
  return { ok: true, block: result.data };
}

export function parseVerifyBlock(text: string): VerifyBlock {
  const result = decodeVerifyBlock(text);
  if (!result.ok) throw new VerifyBlockError(text);
  return result.block;
}
