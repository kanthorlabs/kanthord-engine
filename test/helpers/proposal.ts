import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
