import { gateFilesSchema } from "./contract.ts";
import type { AssessmentRow } from "./record-store.ts";

const NO_PATHS: string[] = [];

export function gateFilesOf(
  assessment: Pick<AssessmentRow, "gate_files"> | null,
  bindingId: string,
): string[] {
  if (assessment === null || assessment.gate_files === null) return NO_PATHS;
  const entry = gateFilesSchema
    .parse(JSON.parse(assessment.gate_files))
    .find((candidate) => candidate.binding_id === bindingId);
  return entry === undefined ? NO_PATHS : entry.paths;
}
