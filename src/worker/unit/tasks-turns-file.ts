import { readFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJSON } from "../../kernel/json.ts";
import {
  tasksDiagnostic,
  TasksErrorCode,
  type TasksPlan,
} from "./tasks-seed.ts";

export const TURNS_VERSION = 1;
export const TurnKind = {
  Header: "header",
  Request: "request",
  Answer: "answer",
  Tool: "tool",
} as const;

const NEWLINE = "\n";
const NO_TEXT = "";
const FIRST_LINE = 1;

const versionSchema = z.looseObject({
  kind: z.literal(TurnKind.Header),
  version: z.number().int(),
});
const overridesSchema = z.strictObject({
  model: z.string().optional(),
  reasoning: z.string().optional(),
  system_prompt: z.string().optional(),
  templates: z.record(z.string(), z.string()).optional(),
  units: z.array(z.string()).optional(),
  budget_turns: z.string().optional(),
  budget_wall: z.string().optional(),
  skip_release_gate: z.literal(true).optional(),
});
const headerSchema = z.strictObject({
  kind: z.literal(TurnKind.Header),
  version: z.literal(TURNS_VERSION),
  seed_digest: z.string().min(1),
  overrides: overridesSchema,
});
const requestSchema = z.strictObject({
  kind: z.literal(TurnKind.Request),
  model: z.strictObject({ provider: z.string(), id: z.string() }),
  messages: z.array(z.looseObject({ role: z.string() })),
});
const answerSchema = z.strictObject({
  kind: z.literal(TurnKind.Answer),
  message: z.looseObject({
    role: z.literal("assistant"),
    content: z.array(z.unknown()),
    stopReason: z.string(),
  }),
  redacted: z.literal(true).optional(),
});
const toolSchema = z.strictObject({
  kind: z.literal(TurnKind.Tool),
  name: z.string().min(1),
  call_id: z.string().min(1),
  result: z
    .strictObject({
      content: z.array(z.unknown()),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.string().optional(),
  redacted: z.literal(true).optional(),
});
const lineSchema = z.discriminatedUnion("kind", [
  requestSchema,
  answerSchema,
  toolSchema,
]);

export type TurnsHeader = z.infer<typeof headerSchema>;
export type TurnsOverrides = TurnsHeader["overrides"];
export type ToolLine = z.infer<typeof toolSchema>;

export interface RecordedTurn {
  request: string;
  answer: unknown;
  redacted: boolean;
}

export interface RecordedTurns {
  header: TurnsHeader;
  turns: RecordedTurn[];
  tools: Map<string, ToolLine>;
}

function replayInvalid(field: string, value: string) {
  return tasksDiagnostic(
    TasksErrorCode.ReplayInvalid,
    "worker tasks run: the --replay file has another version or an invalid line, or it does not match the seed and the file options.",
    [[field, value]],
  );
}

function lineInvalid(line: number) {
  return replayInvalid("line", String(line));
}

function parsedLine(text: string, line: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw lineInvalid(line);
  }
}

function headerOf(lines: readonly string[]): TurnsHeader {
  const value = parsedLine(lines[0] ?? NO_TEXT, FIRST_LINE);
  const version = versionSchema.safeParse(value);
  if (!version.success) throw lineInvalid(FIRST_LINE);
  if (version.data.version !== TURNS_VERSION)
    throw replayInvalid("field", "version");
  const header = headerSchema.safeParse(value);
  if (!header.success) throw lineInvalid(FIRST_LINE);
  return header.data;
}

interface Pairing {
  recorded: RecordedTurns;
  pending: string | null;
}

function addTool(pairing: Pairing, entry: ToolLine, line: number): void {
  if (pairing.recorded.tools.has(entry.call_id)) throw lineInvalid(line);
  if ((entry.result === undefined) === (entry.error === undefined))
    throw lineInvalid(line);
  pairing.recorded.tools.set(entry.call_id, entry);
}

function addLine(pairing: Pairing, text: string, line: number): void {
  const parsed = lineSchema.safeParse(parsedLine(text, line));
  if (!parsed.success) throw lineInvalid(line);
  const entry = parsed.data;
  if (entry.kind === TurnKind.Tool) return addTool(pairing, entry, line);
  if (entry.kind === TurnKind.Request) {
    if (pairing.pending !== null) throw lineInvalid(line);
    pairing.pending = canonicalJSON(entry);
    return;
  }
  if (pairing.pending === null) throw lineInvalid(line);
  pairing.recorded.turns.push({
    request: pairing.pending,
    answer: entry.message,
    redacted: entry.redacted === true,
  });
  pairing.pending = null;
}

export function readTurns(path: string): RecordedTurns {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw replayInvalid("option", "--replay");
  }
  const lines = text.split(NEWLINE);
  if (lines.at(-1) === NO_TEXT) lines.pop();
  const pairing: Pairing = {
    recorded: { header: headerOf(lines), turns: [], tools: new Map() },
    pending: null,
  };
  lines.slice(FIRST_LINE).forEach((entry, index) => {
    addLine(pairing, entry, index + FIRST_LINE + FIRST_LINE);
  });
  if (pairing.pending !== null) throw lineInvalid(lines.length);
  return pairing.recorded;
}

export interface RecordedOptions {
  model?: string;
  reasoning?: string;
  unit: string[];
  budgetTurns?: string;
  budgetWall?: string;
  skipReleaseGate?: boolean;
}

export function recordedOptions(header: TurnsHeader): RecordedOptions {
  const { overrides } = header;
  return {
    model: overrides.model,
    reasoning: overrides.reasoning,
    unit: overrides.units ?? [],
    budgetTurns: overrides.budget_turns,
    budgetWall: overrides.budget_wall,
    skipReleaseGate: overrides.skip_release_gate,
  };
}

const FILE_OVERRIDES = ["system_prompt", "templates"] as const;

export interface FileOptions {
  systemPrompt?: string;
  templates?: string;
}

export function checkFileOptions(
  header: TurnsHeader,
  options: FileOptions,
): void {
  const given = {
    system_prompt: options.systemPrompt !== undefined,
    templates: options.templates !== undefined,
  };
  for (const name of FILE_OVERRIDES)
    if ((header.overrides[name] !== undefined) !== given[name])
      throw replayInvalid("field", name);
}

export function checkHeader(header: TurnsHeader, plan: TasksPlan): void {
  if (header.seed_digest !== plan.digest)
    throw replayInvalid("field", "seed_digest");
  for (const name of FILE_OVERRIDES)
    if (
      canonicalJSON(header.overrides[name] ?? null) !==
      canonicalJSON(plan.overrides[name] ?? null)
    )
      throw replayInvalid("field", name);
}
