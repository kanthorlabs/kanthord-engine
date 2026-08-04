import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { introducedInValues } from "../../src/http/contract/operation.ts";

const sqlFence = /```sql\n([\s\S]*?)```/;

export function proposalStatements(table: string): readonly string[] {
  const file = resolve(
    import.meta.dirname,
    "../../docs/proposal/database",
    `${table}.md`,
  );
  const markdown = readFileSync(file, "utf8");
  const match = markdown.match(sqlFence);
  if (match === null) {
    throw new Error(`no sql block in ${table}.md`);
  }
  const block = match[1] ?? "";
  return block
    .split("\n")
    .map(removeComment)
    .join("\n")
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

function removeComment(line: string): string {
  let quotes = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (char === "'") {
      quotes++;
      continue;
    }
    if (char === "-" && line.charAt(index + 1) === "-" && quotes % 2 === 0) {
      return line.slice(0, index);
    }
  }
  return line;
}

export type ProposalRoute = Readonly<{
  operationId: string;
  method: string;
  path: string;
  introducedIn: string;
  status: string;
  source: string;
}>;

export function readRouteMatrix(): readonly ProposalRoute[] {
  const directory = resolve(import.meta.dirname, "../../docs/proposal/api");
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => name !== "README.md" && name !== "new-decisions.md")
    .sort(bytewise);

  const rows: ProposalRoute[] = [];
  for (const file of files) {
    const markdown = readFileSync(resolve(directory, file), "utf8");
    for (const line of markdown.split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (
        cells.length !== 5 ||
        !(introducedInValues as readonly string[]).includes(cells[2] ?? "")
      ) {
        continue;
      }
      const [method, path] = splitMethodAndPath(cells[1] ?? "");
      rows.push({
        operationId: stripBackticks(cells[0] ?? ""),
        method,
        path,
        introducedIn: stripBackticks(cells[2] ?? ""),
        status: stripBackticks(cells[3] ?? ""),
        source: cells[4] ?? "",
      });
    }
  }
  return rows;
}

export function readErrorCodeMatrix(): Readonly<Record<string, number>> {
  const readme = readFileSync(
    resolve(import.meta.dirname, "../../docs/proposal/api/README.md"),
    "utf8",
  );
  const codes: Record<string, number> = {};
  for (const line of readme.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 3) continue;
    const status = Number(cells[0]);
    if (!Number.isInteger(status) || status < 400 || status > 599) continue;
    codes[stripBackticks(cells[1] ?? "")] = status;
  }
  return codes;
}

function splitMethodAndPath(cell: string): [string, string] {
  const withoutBackticks = stripBackticks(cell);
  const space = withoutBackticks.indexOf(" ");
  if (space === -1) {
    return [withoutBackticks, ""];
  }
  return [withoutBackticks.slice(0, space), withoutBackticks.slice(space + 1)];
}

function stripBackticks(value: string): string {
  return value.replace(/^`|`$/g, "");
}

function bytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
