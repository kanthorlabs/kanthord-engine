import {
  AssetKind,
  type ExecutionDependency,
  type Outcome,
} from "../../mission/contract.ts";
import type { Verification } from "./verification.ts";

const ABSENT = "none";

function labelOf(dependency: ExecutionDependency): string {
  return "filename" in dependency ? dependency.filename : dependency.id;
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

function dependencyTable(
  dependencies: readonly ExecutionDependency[],
  outcomes: readonly Outcome[],
): string {
  const rows = dependencies.map((dependency) => {
    const outcome = currentOutcome(outcomes, dependency.id);
    return `| ${labelOf(dependency)} | ${code(dependency.id)} | ${dependency.state} | ${outcome ? code(outcome.id) : ABSENT} | ${outcome?.result ?? ABSENT} | ${outcome ? code(outcome.assessment_id) : ABSENT} |`;
  });
  return [
    "| Dependency | Node | State | Outcome | Result | Assessment |",
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
  dependencies: readonly ExecutionDependency[],
  outcomes: readonly Outcome[],
  verification: Verification | null,
): string {
  return `## Facts recorded by KanthorD\n\n${dependencyTable(dependencies, outcomes)}\n\n### Final-snapshot verification\n\n${verificationSection(verification)}`;
}
