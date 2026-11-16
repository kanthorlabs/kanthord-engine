import { AGENT_DECLARATIONS } from "../agent/catalog.ts";
import type { Operation } from "../kernel/operation.ts";
import { isObject } from "../kernel/values.ts";
import { missionOperations } from "../mission/contract.ts";
import {
  guardClassOf,
  HUMAN_ONLY_OPERATIONS,
  toolName,
} from "../workbench/index.ts";
import type { ObservedCall } from "./score.ts";

export type OperationLookup = (id: string) => Operation | undefined;

export const PlanRule = {
  Sections: "sections",
  Operation: "operation",
  Actor: "actor",
  Guard: "guard",
  FactSource: "fact_source",
  ImportPreview: "import_preview",
  Input: "input",
} as const;

const SECTIONS = [
  "## Conclusion",
  "## Facts",
  "## Plan",
  "## Risks",
  "## Decisions",
  "## Review",
] as const;
const HEADING_PREFIX = "## ";
const PLAN_SECTION = "## Plan";
const FACTS_SECTION = "## Facts";
const LINE_BREAK = /\r?\n/;
const STEP_LINE = /^\s*\d+\.\s/;
const FACT_LINE = /^\s*-\s*F\d+\s/;
const OPERATION_FIELD = /\boperation:([\w.]+)/;
const ACTOR_FIELD = /\bactor:(\w+)/;
const GUARD_FIELD = /\bguard:(\w+)/;
const INPUT_FIELD = /\binput:(.*?)\s+-\s+guard:/;
const SOURCE_FIELD = /\bsource:([\w.]+)\s+\S+/;
const YUMI_ACTOR = "yumi";
const HUMAN_ONLY_CLASS = "human_only";
const NOT_FOUND = -1;
const NO_RETIREMENTS = 0;
const FIRST_INDEX = 0;
const FIRST_AFTER = 1;
const CREATING_OPERATIONS: readonly string[] = [
  missionOperations["node.create"].id,
  missionOperations["import.apply"].id,
];
const PREVIEW_TOOL = toolName(missionOperations["import.preview"].id);

interface Step {
  number: number;
  actor: string | undefined;
  operation: string | undefined;
  guard: string | undefined;
  input: unknown;
  inputValid: boolean;
}

function sectionLines(lines: readonly string[], heading: string): string[] {
  const start = lines.indexOf(heading);
  if (start === NOT_FOUND) return [];
  const rest = lines.slice(start + FIRST_AFTER);
  const end = rest.findIndex((line) => line.startsWith(HEADING_PREFIX));
  return end === NOT_FOUND ? rest : rest.slice(0, end);
}

function sectionFailures(lines: readonly string[]): string[] {
  const positions = SECTIONS.map((heading) => lines.indexOf(heading));
  const ordered = positions.every(
    (position, index) =>
      position !== NOT_FOUND &&
      (index === FIRST_INDEX || position > positions[index - FIRST_AFTER]!),
  );
  return ordered
    ? []
    : [`${PlanRule.Sections}: the text lacks ${SECTIONS.join(", ")} in order`];
}

function inputOf(line: string): { input: unknown; inputValid: boolean } {
  const text = INPUT_FIELD.exec(line)?.[FIRST_AFTER];
  if (text === undefined) return { input: undefined, inputValid: true };
  try {
    return { input: JSON.parse(text), inputValid: true };
  } catch {
    return { input: undefined, inputValid: false };
  }
}

function stepsOf(lines: readonly string[]): Step[] {
  return sectionLines(lines, PLAN_SECTION)
    .filter((line) => STEP_LINE.test(line))
    .map((line, index) => ({
      number: index + FIRST_AFTER,
      actor: ACTOR_FIELD.exec(line)?.[FIRST_AFTER],
      operation: OPERATION_FIELD.exec(line)?.[FIRST_AFTER],
      guard: GUARD_FIELD.exec(line)?.[FIRST_AFTER],
      ...inputOf(line),
    }));
}

function confirmsRetirement(input: unknown): boolean {
  if (!isObject(input)) return false;
  const { body } = input as { body?: unknown };
  if (!isObject(body)) return false;
  const retirements = (body as { confirmed_retirements?: unknown })
    .confirmed_retirements;
  return Array.isArray(retirements) && retirements.length > NO_RETIREMENTS;
}

function guardAccepted(step: Step, operation: Operation): boolean {
  if (step.guard === guardClassOf(operation)) return true;
  if (step.guard !== HUMAN_ONLY_CLASS) return false;
  return (
    HUMAN_ONLY_OPERATIONS.has(operation.id) ||
    (operation.id === missionOperations["import.apply"].id &&
      confirmsRetirement(step.input))
  );
}

function stepFailures(step: Step, lookup: OperationLookup): string[] {
  const label = `step ${step.number}`;
  if (step.operation === undefined)
    return [`${PlanRule.Operation}: ${label} names no operation`];
  const operation = lookup(step.operation);
  if (!operation)
    return [
      `${PlanRule.Operation}: ${label} names ${step.operation}, absent from the registry`,
    ];
  const failures: string[] = [];
  if (!step.inputValid)
    failures.push(`${PlanRule.Input}: ${label} holds no valid JSON input`);
  if (
    step.actor === YUMI_ACTOR &&
    !(
      operation.mutation === true &&
      AGENT_DECLARATIONS["ops@1"].tools.operation.includes(operation.id)
    )
  )
    failures.push(
      `${PlanRule.Actor}: ${label} gives actor:yumi to ${operation.id}, not a mutation of the ops@1 list`,
    );
  if (!guardAccepted(step, operation))
    failures.push(
      `${PlanRule.Guard}: ${label} gives guard:${step.guard ?? "none"} to ${operation.id}, which is ${guardClassOf(operation)}`,
    );
  return failures;
}

function factFailures(
  lines: readonly string[],
  calls: readonly ObservedCall[],
): string[] {
  return sectionLines(lines, FACTS_SECTION)
    .filter((line) => FACT_LINE.test(line))
    .flatMap((line) => {
      const source = SOURCE_FIELD.exec(line)?.[FIRST_AFTER];
      if (source === undefined)
        return [`${PlanRule.FactSource}: a fact names no source: ${line}`];
      return calls.some((call) => call.name === toolName(source))
        ? []
        : [`${PlanRule.FactSource}: no call of the run reads ${source}`];
    });
}

function previewFailures(
  steps: readonly Step[],
  calls: readonly ObservedCall[],
): string[] {
  const creating = steps.filter(
    (step) =>
      step.operation !== undefined &&
      CREATING_OPERATIONS.includes(step.operation),
  );
  if (!creating.length || calls.some((call) => call.name === PREVIEW_TOOL))
    return [];
  return [
    `${PlanRule.ImportPreview}: step ${creating[0]!.number} creates nodes and no call of the run previews the import`,
  ];
}

export function planContractFailures(
  text: string,
  calls: readonly ObservedCall[],
  lookup: OperationLookup,
): string[] {
  const lines = text.split(LINE_BREAK).map((line) => line.trimEnd());
  const steps = stepsOf(lines);
  return [
    ...sectionFailures(lines),
    ...steps.flatMap((step) => stepFailures(step, lookup)),
    ...factFailures(lines, calls),
    ...previewFailures(steps, calls),
  ];
}
