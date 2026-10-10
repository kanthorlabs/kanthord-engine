import {
  AssetKind,
  type ExecutionObjective,
  type Outcome,
} from "../mission/contract.ts";
import type { Verification } from "./verification.ts";

const ABSENT = "none";

function labelOf(objective: ExecutionObjective): string {
  return "filename" in objective ? objective.filename : objective.id;
}

function currentOutcome(
  outcomes: readonly Outcome[],
  nodeId: string,
): Outcome | undefined {
  return outcomes
    .filter((outcome) => outcome.node_id === nodeId)
    .toSorted((left, right) => right.created_at - left.created_at)[0];
}

function code(value: string): string {
  return `\`${value}\``;
}

function objectiveTable(
  objectives: readonly ExecutionObjective[],
  outcomes: readonly Outcome[],
): string {
  const rows = objectives.map((objective) => {
    const outcome = currentOutcome(outcomes, objective.id);
    return `| ${labelOf(objective)} | ${code(objective.id)} | ${objective.state} | ${outcome ? code(outcome.id) : ABSENT} | ${outcome?.result ?? ABSENT} | ${outcome ? code(outcome.assessment_id) : ABSENT} |`;
  });
  return [
    "| Objective | Node | State | Outcome | Result | Assessment |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function verificationSection(verification: Verification | null): string {
  if (verification === null)
    return "No final-snapshot verification ran: the initiative names no repository binding.";
  const inputs = [verification.tested_input]
    .flat()
    .map((input) =>
      input.kind === AssetKind.Repository
        ? `- ${code(input.binding_id)} at ${code(input.commit)}`
        : `- ${input.kind} ${code(JSON.stringify(input))}`,
    );
  const rows = verification.results.map(
    (result) =>
      `| ${code(result.command)} | ${result.exit_code ?? ABSENT} | ${result.signal ?? ABSENT} | ${result.timed_out} |`,
  );
  return [
    "Tested input:",
    ...inputs,
    "",
    "| Command | Exit code | Signal | Timed out |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function reportFacts(
  objectives: readonly ExecutionObjective[],
  outcomes: readonly Outcome[],
  verification: Verification | null,
): string {
  return `## Facts recorded by KanthorD\n\n${objectiveTable(objectives, outcomes)}\n\n### Final-snapshot verification\n\n${verificationSection(verification)}`;
}
