import type { TaskContent } from "../../mission/contract.ts";
import type { StepsState } from "./steps-implement.ts";

const HEADING_PATTERN = /^## (\S+) /;
const SECTION_SEPARATOR = "\n\n";
const LINE_SEPARATOR = "\n";

export function reportSectionOf(unit: TaskContent, text: string): string {
  return `## ${unit.id} ${unit.content.name}${SECTION_SEPARATOR}${text}`;
}

export function earlierSectionsOf(
  report: string | null,
  unitIds: readonly string[],
): ReadonlyMap<string, string> {
  const known = new Set(unitIds);
  const lines = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of (report ?? "").split(LINE_SEPARATOR)) {
    const id = HEADING_PATTERN.exec(line)?.[1];
    if (id !== undefined && known.has(id)) {
      current = [];
      lines.set(id, current);
    }
    current?.push(line);
  }
  return new Map(
    [...lines].map(([id, section]) => [
      id,
      section.join(LINE_SEPARATOR).trimEnd(),
    ]),
  );
}

export function earlierSectionOf(
  state: Pick<StepsState, "earlierReport" | "input" | "revision">,
  unitId: string,
): string | null {
  const unitIds = [
    ...state.revision.tasks.map((task) => task.id),
    state.input.claim.node_id,
  ];
  return earlierSectionsOf(state.earlierReport, unitIds).get(unitId) ?? null;
}
