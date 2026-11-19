import { readFileSync, realpathSync } from "node:fs";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { SESSION_MARKER_PATTERN } from "../../agent/sensitive-text.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import type { TasksOutput } from "./tasks-output.ts";
import { tasksDiagnostic, TasksErrorCode } from "./tasks-seed.ts";

export const TURNS_VERSION = 1;
export const TurnKind = {
  Header: "header",
  Request: "request",
  Answer: "answer",
  Tool: "tool",
} as const;

const OUTPUT_TOKEN = "<kanthord:output>";
const NEWLINE = "\n";
const NO_TEXT = "";
const FIRST_LINE = 1;
const UNTIMED_KEYS: readonly string[] = ["timestamp", "durationMs"];
const STOP_FAILURES: readonly string[] = ["error", "aborted"];
const DIVERGED = "The replay diverged from the recorded turns.";

const headerSchema = z.strictObject({
  kind: z.literal(TurnKind.Header),
  version: z.number().int(),
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
});
const toolSchema = z.strictObject({
  kind: z.literal(TurnKind.Tool),
  name: z.string().min(1),
  call_id: z.string().min(1),
  result: z.looseObject({ content: z.array(z.unknown()) }).optional(),
  error: z.string().optional(),
});
const lineSchema = z.discriminatedUnion("kind", [
  requestSchema,
  answerSchema,
  toolSchema,
]);
type ToolLine = z.infer<typeof toolSchema>;

export interface RecordedTurn {
  request: string;
  answer: unknown;
}

export interface RecordedTurns {
  turns: RecordedTurn[];
  tools: Map<string, ToolLine>;
}

function replayInvalid(fields: [string, string][]) {
  return tasksDiagnostic(
    TasksErrorCode.ReplayInvalid,
    "worker tasks run: the --replay file has another version or an invalid line.",
    fields,
  );
}

function parsedLine(text: string, line: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw replayInvalid([["line", String(line)]]);
  }
}

function headerOf(lines: readonly string[]): void {
  const header = headerSchema.safeParse(parsedLine(lines[0] ?? "", FIRST_LINE));
  if (!header.success) throw replayInvalid([["line", String(FIRST_LINE)]]);
  if (header.data.version !== TURNS_VERSION)
    throw replayInvalid([["field", "version"]]);
}

interface Pairing {
  recorded: RecordedTurns;
  pending: string | null;
}

function addLine(pairing: Pairing, text: string, line: number): void {
  const parsed = lineSchema.safeParse(parsedLine(text, line));
  const invalid = () => replayInvalid([["line", String(line)]]);
  if (!parsed.success) throw invalid();
  const entry = parsed.data;
  if (entry.kind === TurnKind.Tool) {
    if (pairing.recorded.tools.has(entry.call_id)) throw invalid();
    if ((entry.result === undefined) === (entry.error === undefined))
      throw invalid();
    pairing.recorded.tools.set(entry.call_id, entry);
    return;
  }
  if (entry.kind === TurnKind.Request) {
    if (pairing.pending !== null) throw invalid();
    pairing.pending = canonicalJSON(entry);
    return;
  }
  if (pairing.pending === null) throw invalid();
  pairing.recorded.turns.push({
    request: pairing.pending,
    answer: entry.message,
  });
  pairing.pending = null;
}

export function readTurns(path: string): RecordedTurns {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw replayInvalid([["option", "--replay"]]);
  }
  const lines = text.split(NEWLINE);
  if (lines.at(-1) === NO_TEXT) lines.pop();
  headerOf(lines);
  const pairing: Pairing = {
    recorded: { turns: [], tools: new Map() },
    pending: null,
  };
  lines.slice(FIRST_LINE).forEach((entry, index) => {
    addLine(pairing, entry, index + FIRST_LINE + FIRST_LINE);
  });
  if (pairing.pending !== null)
    throw replayInvalid([["line", String(lines.length)]]);
  return pairing.recorded;
}

class OutputPaths {
  private readonly forms: readonly string[];
  private readonly shown: string;

  constructor(folder: string) {
    const quoted = (path: string) => JSON.stringify(path).slice(1, -1);
    this.forms = [...new Set([realpathSync(folder), folder])]
      .toSorted((a, b) => b.length - a.length)
      .map(quoted);
    this.shown = quoted(folder);
  }

  hidden(text: string): string {
    let result = text;
    for (const form of this.forms)
      result = result.split(form).join(OUTPUT_TOKEN);
    return result;
  }

  show<T>(value: unknown): T {
    return JSON.parse(
      JSON.stringify(value).split(OUTPUT_TOKEN).join(this.shown),
    ) as T;
  }

  hide(value: unknown): unknown {
    return JSON.parse(this.hidden(JSON.stringify(value)));
  }
}

function untimed(message: object): object {
  return Object.fromEntries(
    Object.entries(message).filter(([key]) => !UNTIMED_KEYS.includes(key)),
  );
}

function sessionless(_whole: string, rule: string, index: string): string {
  return `<redacted:${rule}:${index}:session>`;
}

function answerStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: structuredClone(message) });
  if (STOP_FAILURES.includes(message.stopReason))
    stream.push({
      type: "error",
      reason: message.stopReason as "error" | "aborted",
      error: message,
    });
  else
    stream.push({
      type: "done",
      reason: message.stopReason as "stop" | "length" | "toolUse",
      message,
    });
  stream.end();
  return stream;
}

export interface TurnsInput {
  output: TasksOutput;
  replay: RecordedTurns | null;
  onDiverged(): void;
}

type ToolRun = () => Promise<AgentToolResult<unknown>>;

export class Turns {
  private readonly output: TasksOutput;
  private readonly replay: RecordedTurns | null;
  private readonly onDiverged: () => void;
  private readonly paths: OutputPaths;
  private position = 0;
  private hasDiverged = false;
  private writeError: unknown = null;

  constructor(input: TurnsInput) {
    this.output = input.output;
    this.replay = input.replay;
    this.onDiverged = input.onDiverged;
    this.paths = new OutputPaths(input.output.folder);
    this.write({ kind: TurnKind.Header, version: TURNS_VERSION });
  }

  get diverged(): boolean {
    return this.hasDiverged;
  }

  get failure(): unknown {
    return this.writeError;
  }

  private write(record: unknown): void {
    try {
      this.output.turn(record);
    } catch (error) {
      this.writeError ??= error;
    }
  }

  private diverge(): never {
    this.hasDiverged = true;
    this.onDiverged();
    throw new Error(DIVERGED);
  }

  private requestOf(model: Model<Api>, messages: readonly object[]): unknown {
    const text = JSON.stringify({
      kind: TurnKind.Request,
      model: { provider: model.provider, id: model.id },
      messages: messages.map(untimed),
    });
    return this.output.redacted(
      JSON.parse(
        this.paths.hidden(text).replace(SESSION_MARKER_PATTERN, sessionless),
      ),
    );
  }

  private replayed(request: unknown): AssistantMessageEventStream {
    const turn = this.replay?.turns[this.position];
    if (turn === undefined || turn.request !== canonicalJSON(request))
      return this.diverge();
    this.position += 1;
    return answerStream(this.paths.show<AssistantMessage>(turn.answer));
  }

  stream(original: StreamFn): StreamFn {
    return async (model, context, options) => {
      const request = this.requestOf(model, context.messages);
      this.write(request);
      const stream =
        this.replay === null
          ? await original(model, context, options)
          : this.replayed(request);
      void stream.result().then((message) => {
        this.write({
          kind: TurnKind.Answer,
          message: this.paths.hide(message),
        });
      });
      return stream;
    };
  }

  private recordTool(line: Omit<ToolLine, "kind">): void {
    this.write({ kind: TurnKind.Tool, ...line });
  }

  private async liveTool(
    name: string,
    callId: string,
    run: ToolRun,
  ): Promise<AgentToolResult<unknown>> {
    try {
      const result = await run();
      this.recordTool({
        name,
        call_id: callId,
        result: this.paths.hide(result) as ToolLine["result"],
      });
      return result;
    } catch (error) {
      this.recordTool({
        name,
        call_id: callId,
        error: this.paths.hidden(
          error instanceof Error ? error.message : String(error),
        ),
      });
      throw error;
    }
  }

  async tool(
    name: string,
    callId: string,
    run: ToolRun,
  ): Promise<AgentToolResult<unknown>> {
    if (this.replay === null) return this.liveTool(name, callId, run);
    const recorded = this.replay.tools.get(callId);
    if (recorded === undefined || recorded.name !== name) return this.diverge();
    this.replay.tools.delete(callId);
    this.recordTool({
      name: recorded.name,
      call_id: recorded.call_id,
      result: recorded.result,
      error: recorded.error,
    });
    if (recorded.error !== undefined)
      throw new Error(this.paths.show<string>(recorded.error));
    return this.paths.show<AgentToolResult<unknown>>(recorded.result);
  }
}
