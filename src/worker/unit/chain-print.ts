import { BudgetLimit } from "../../scheduler/contract.ts";
import { EndReason } from "./execution-stop.ts";
import {
  BudgetEndKind,
  type Chain,
  type ChainNode,
  type ChainStep,
  DeadlineKind,
  NodeKind,
  SEED_KEYS,
} from "./chain.ts";
import { Phase } from "./telemetry.ts";

const INDENT = "  ";
const NOTE_COLUMN = 44;
const CHAIN_DEPTH = 1;
const NODE_DEPTH = 2;
const NEXT_DEPTH = 1;

function line(depth: number, text: string, note: string): string {
  const head = `${INDENT.repeat(depth)}${text}`;
  return note ? `${head.padEnd(NOTE_COLUMN)}${note}` : head;
}

function stepNote(step: ChainStep): string {
  const marks = [
    ...(step.llm ? ["[LLM]"] : []),
    ...(step.deadline === DeadlineKind.Cleanup ? ["[cleanup]"] : []),
  ];
  const texts = [
    ...(step.foundry && step.ports.length
      ? [`port: ${step.ports.join(", ")}`]
      : []),
    ...(step.note ? [step.note] : []),
    ...(step.stops.length ? [`stop ${step.stops.join(", ")}`] : []),
  ];
  return [...marks, texts.join("; ")].join(" ").trim();
}

function nodeLines(nodes: readonly ChainNode[], depth: number): string[] {
  return nodes.flatMap((node) =>
    node.kind === NodeKind.Step
      ? [line(depth, `step ${node.step.id}`, stepNote(node.step))]
      : [
          line(depth, `loop ${node.id}`, node.frame.note ?? ""),
          ...nodeLines(node.frame.body, depth + NEXT_DEPTH),
        ],
  );
}

function budgetEndLines(built: Chain): string[] {
  const rule = built.budgetEnd;
  if (rule.kind === BudgetEndKind.Stop)
    return [
      line(CHAIN_DEPTH, `budget_end in each phase: stop ${rule.reason}`, ""),
    ];
  return [
    line(
      CHAIN_DEPTH,
      `budget_end in prepare: stop ${EndReason.BudgetEnd}/${BudgetLimit.WallTime}`,
      "",
    ),
    line(CHAIN_DEPTH, "onExit budget_end, after prepare", ""),
    ...nodeLines(rule.nodes, NODE_DEPTH),
  ];
}

function phaseNote(built: Chain, phase: Phase): string {
  return phase === Phase.Tasks && built.tasks
    ? `one call: ${built.tasks.name}(input, host)`
    : "";
}

export function printChain(built: Chain): string {
  return [
    `chain ${built.id}`,
    line(CHAIN_DEPTH, `seed ${SEED_KEYS.join(", ")}`, ""),
    ...built.phases.flatMap(({ phase, nodes }) => [
      line(CHAIN_DEPTH, `phase ${phase}`, phaseNote(built, phase)),
      ...nodeLines(nodes, NODE_DEPTH),
    ]),
    ...budgetEndLines(built),
    line(
      CHAIN_DEPTH,
      "onStop not revoked, after prepare",
      built.onStop.length ? "" : "no node",
    ),
    ...nodeLines(built.onStop, NODE_DEPTH),
    line(CHAIN_DEPTH, "dispose resources", "on every end"),
    line(
      CHAIN_DEPTH,
      "step execution.release(stop)",
      "[cleanup] on each stop that is not revoked",
    ),
  ].join("\n");
}
