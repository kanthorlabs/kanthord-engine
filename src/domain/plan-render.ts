import { canonicalPaths } from "./plan-canonical-path.ts";
import type { CanonicalNode } from "./plan-canonical-path.ts";
import { comparePaths } from "./plan-path.ts";
import type { NodeKind } from "./state.ts";

export type RenderInput = Readonly<{
  identity: string;
  kind: NodeKind;
  title: string;
  dependencies: readonly string[];
  worker: string | null;
  repo: string | null;
  instruction: string;
  acceptance: string | null;
}>;

export function quoteScalar(value: string): string {
  let result = '"';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\") {
      result += "\\\\";
    } else if (character === '"') {
      result += '\\"';
    } else if (character === "\n") {
      result += "\\n";
    } else if (character === "\r") {
      result += "\\r";
    } else if (character === "\t") {
      result += "\\t";
    } else if (code < 0x20 || code === 0x7f) {
      result += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      result += character;
    }
  }
  result += '"';
  return result;
}

export function renderDocument(input: RenderInput): string {
  const lines = ["---"];
  lines.push(`id: ${quoteScalar(input.identity)}`);
  lines.push(`kind: ${quoteScalar(input.kind)}`);
  lines.push(`title: ${quoteScalar(input.title)}`);
  if (input.dependencies.length > 0) {
    lines.push("depends_on:");
    const sorted = [...input.dependencies].sort((left, right) =>
      comparePaths(left, right),
    );
    for (const dependency of sorted) {
      lines.push(`  - ${quoteScalar(dependency)}`);
    }
  }
  if (input.worker !== null) {
    lines.push(`worker: ${quoteScalar(input.worker)}`);
  }
  if (input.repo !== null) {
    lines.push(`repo: ${quoteScalar(input.repo)}`);
  }
  lines.push("---");

  let body = input.instruction + (input.acceptance ?? "");
  if (!body.endsWith("\n")) {
    body += "\n";
  }
  return `${lines.join("\n")}\n${body}`;
}

export type RenderedDocument = Readonly<{ path: string; content: string }>;

export function renderDocumentSet(
  nodes: readonly CanonicalNode[],
  bodies: ReadonlyMap<
    string,
    Readonly<{
      instruction: string;
      acceptance: string | null;
      worker: string | null;
      repo: string | null;
    }>
  >,
): readonly RenderedDocument[] {
  const paths = canonicalPaths(nodes);
  const documents: RenderedDocument[] = [];
  for (const node of nodes) {
    const body = bodies.get(node.identity);
    if (body === undefined) {
      throw new Error(`no body is known for ${node.identity}`);
    }
    const path = paths.get(node.identity);
    if (path === undefined) {
      throw new Error(`no canonical path is known for ${node.identity}`);
    }
    documents.push({
      path,
      content: renderDocument({
        identity: node.identity,
        kind: node.kind,
        title: node.title,
        dependencies: node.dependencies,
        worker: body.worker,
        repo: body.repo,
        instruction: body.instruction,
        acceptance: body.acceptance,
      }),
    });
  }
  documents.sort((left, right) => comparePaths(left.path, right.path));
  return documents;
}
