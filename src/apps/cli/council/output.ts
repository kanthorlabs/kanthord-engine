import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Diagnostic } from "../../../kernel/errors.ts";
import {
  NodeKind,
  planFileNameSchema,
  type PlanFileEntry,
} from "../../../mission/contract.ts";
import { serializePlanFile } from "../../../mission/plan-file.ts";
import { parsePlanFile } from "../../../mission/parser.ts";
import {
  CouncilErrorCode,
  type CouncilRecord,
  type Plan,
  type PlanEntry,
} from "./contract.ts";

export const RECORD_FILENAME = "council.md";
const NO_ITEMS = 0;
const PARENT_KIND: Readonly<Record<string, string>> = {
  [NodeKind.Objective]: NodeKind.Initiative,
  [NodeKind.Task]: NodeKind.Objective,
};

function invalid(filename: string, reason: string): Diagnostic {
  return new Diagnostic(
    CouncilErrorCode.PlanFileInvalid,
    `${filename}: ${reason}`,
  );
}

function normalized(entry: PlanEntry): PlanEntry {
  return {
    ...entry,
    name: entry.name.trim(),
    requirement: entry.requirement.trim(),
    criterion: entry.criterion.trim(),
  };
}

function checkSet(entries: readonly PlanEntry[]): void {
  const kinds = new Map<string, string>();
  for (const entry of entries) {
    if (!planFileNameSchema.safeParse(entry.filename).success)
      throw invalid(entry.filename, "the filename is not lower-case-words.md");
    if (kinds.has(entry.filename))
      throw invalid(entry.filename, "the filename repeats");
    kinds.set(entry.filename, entry.kind);
  }
  for (const entry of entries) {
    if (entry.kind === NodeKind.Task && entry.depends_on !== undefined)
      throw invalid(entry.filename, "a task holds no depends_on");
    if (
      entry.parent !== undefined &&
      kinds.get(entry.parent) !== PARENT_KIND[entry.kind]
    )
      throw invalid(
        entry.filename,
        `the parent ${entry.parent} is no ${PARENT_KIND[entry.kind] ?? "parent"} of the set`,
      );
    for (const name of entry.depends_on ?? [])
      if (!kinds.has(name))
        throw invalid(
          entry.filename,
          `depends_on names ${name}, which is not in the set`,
        );
  }
}

export function renderPlanFiles(plan: Plan): PlanFileEntry[] {
  const entries = plan.entries.map(normalized);
  checkSet(entries);
  return entries.map((entry) => {
    const content = serializePlanFile(entry);
    let parsed;
    try {
      parsed = parsePlanFile(entry.filename, content);
    } catch (error) {
      throw invalid(
        entry.filename,
        error instanceof Error ? error.message : String(error),
      );
    }
    const expected = { ...entry, depends_on: entry.depends_on ?? [] };
    if (!isDeepStrictEqual(parsed, expected))
      throw invalid(
        entry.filename,
        "the plan file does not read back unchanged",
      );
    return { filename: entry.filename, content };
  });
}

function bullets(items: readonly string[]): string {
  return items.length === NO_ITEMS
    ? "- None."
    : items.map((item) => `- ${item}`).join("\n");
}

export function renderRecord(record: CouncilRecord): string {
  const parts = [
    "# Council record",
    `## Idea\n\n${record.idea}`,
    `## Triage\n\nComplexity ${record.triage.complexity}.\n\n${bullets(record.triage.reasons)}`,
  ];
  record.rounds.forEach((round, index) => {
    parts.push(
      `## Round ${index + 1}\n\n### Questions\n\n${bullets(round.questions)}`,
    );
    for (const [role, answer] of Object.entries(round.answers)) {
      const lines = answer!.answers.map(
        (item) =>
          `- **${item.question}** ${item.answer} (confidence ${item.confidence}; assumptions: ${item.assumptions.length === NO_ITEMS ? "none" : item.assumptions.join("; ")})`,
      );
      parts.push(`### ${role}\n\n${lines.join("\n")}`);
    }
  });
  parts.push(
    `## Synthesis\n\n### Agreements\n\n${bullets(record.synthesis.agreements)}\n\n### Conflicts\n\n${bullets(record.synthesis.conflicts)}\n\n### Direction\n\n${record.synthesis.direction}`,
  );
  parts.push(
    `## Plan\n\n${record.plan.entries
      .map(
        (entry) =>
          `- \`${entry.filename}\` (${entry.kind}): ${record.plan.reasons[entry.filename] ?? "No reason given."}`,
      )
      .join("\n")}`,
  );
  return `${parts.join("\n\n")}\n`;
}

export function requireEmptyOutput(dir: string): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory() || readdirSync(dir).length > NO_ITEMS)
    throw new Diagnostic(
      CouncilErrorCode.OutputDirectoryNotEmpty,
      `${dir} exists and is not an empty directory`,
    );
}

export function writeOutput(
  dir: string,
  files: readonly PlanFileEntry[],
  record: string,
): void {
  requireEmptyOutput(dir);
  mkdirSync(dir, { recursive: true });
  for (const file of files)
    writeFileSync(join(dir, file.filename), file.content);
  writeFileSync(join(dir, RECORD_FILENAME), record);
}
