import { realpathSync } from "node:fs";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { SESSION_MARKER_PATTERN } from "../../agent/sensitive-text.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import { isObject, ValueType } from "../../kernel/values.ts";
import { BuiltinTool } from "../../agent/catalog.ts";
import type { TasksOutput } from "./tasks-output.ts";
import { tasksDiagnostic, TasksErrorCode } from "./tasks-seed.ts";
import {
  type RecordedTurns,
  type ToolLine,
  TurnKind,
  TURNS_VERSION,
  type TurnsOverrides,
} from "./tasks-turns-file.ts";

export const DivergeReason = {
  RequestDiffers: "request_differs",
  RequestExtra: "request_extra",
  ToolUnrecorded: "tool_unrecorded",
  RedactedRecord: "redacted_record",
  TurnsUnused: "turns_unused",
} as const;
export type DivergeReason = (typeof DivergeReason)[keyof typeof DivergeReason];

export interface Divergence {
  turn: number;
  reason: DivergeReason;
  step: string | null;
}

export interface Drift {
  turn: number;
  step: string | null;
  message_index: number;
  tool_call_id: string;
  tool_name: string;
}

interface SentRequest {
  messages: readonly Record<string, unknown>[];
}

const OUTPUT_TOKEN = "<kanthord:output>";
const BASH_LOG_TOKEN = "<kanthord:pi-bash-log>";
const BASH_LOG_PATTERN = /[^\s"\]]*pi-bash-[0-9a-f]+\.log/g;
const UNSENT_KEYS: readonly string[] = ["timestamp", "durationMs", "details"];
const STOP_FAILURES: readonly string[] = ["error", "aborted"];
const DIVERGED = "The replay diverged from the recorded turns.";
const NEXT_TURN = 1;
const NO_TOOLS = 0;
const TOOL_RESULT_ROLE = "toolResult";

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

function sentPart(message: object): object {
  return Object.fromEntries(
    Object.entries(message).filter(([key]) => !UNSENT_KEYS.includes(key)),
  );
}

const HOST_OUTPUT_TOOLS: readonly unknown[] = Object.values(BuiltinTool);
const TEXT_PART = "text";

function isHostOutput(message: Record<string, unknown>): boolean {
  return (
    message.role === TOOL_RESULT_ROLE &&
    HOST_OUTPUT_TOOLS.includes(message.toolName) &&
    typeof message.toolCallId === ValueType.String &&
    Array.isArray(message.content)
  );
}

function shapeOfPart(part: unknown): unknown {
  if (!isObject(part) || (part as { type?: unknown }).type !== TEXT_PART)
    return part;
  return { ...part, text: null };
}

function structureOf(request: SentRequest): string {
  return canonicalJSON({
    ...request,
    messages: request.messages.map((message) =>
      isHostOutput(message)
        ? {
            ...message,
            content: (message.content as unknown[]).map(shapeOfPart),
          }
        : message,
    ),
  });
}

function ruleMarker(_whole: string, rule: string): string {
  return `<redacted:${rule}>`;
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

export function replayDiverged(divergence: Divergence) {
  return tasksDiagnostic(
    TasksErrorCode.ReplayDiverged,
    "worker tasks run: the replay diverged from the recorded turns.",
    [
      ["turn", String(divergence.turn)],
      ["reason", divergence.reason],
      ...(divergence.step === null
        ? []
        : [["step", divergence.step] as [string, string]]),
    ],
  );
}

export interface TurnsHeaderInput {
  seed_digest: string;
  overrides: TurnsOverrides;
}

export interface TurnsInput {
  output: TasksOutput;
  header: TurnsHeaderInput;
  replay: RecordedTurns | null;
  onDiverged(): void;
}

type ToolRun = () => Promise<AgentToolResult<unknown>>;
type ToolRecord = Omit<ToolLine, "kind" | "redacted">;

export class Turns {
  private readonly output: TasksOutput;
  private readonly replay: RecordedTurns | null;
  private readonly onDiverged: () => void;
  private readonly paths: OutputPaths;
  private position = 0;
  private divergence: Divergence | null = null;
  private readonly drifted = new Map<string, Drift>();
  private writeError: unknown = null;

  constructor(input: TurnsInput) {
    this.output = input.output;
    this.replay = input.replay;
    this.onDiverged = input.onDiverged;
    this.paths = new OutputPaths(input.output.folder);
    this.write({
      kind: TurnKind.Header,
      version: TURNS_VERSION,
      ...input.header,
    });
  }

  get diverged(): Divergence | null {
    return this.divergence;
  }

  get drifts(): Drift[] {
    return [...this.drifted.values()];
  }

  get failure(): unknown {
    return this.writeError;
  }

  unused(): boolean {
    if (this.replay === null) return false;
    return (
      this.position < this.replay.turns.length ||
      this.replay.tools.size > NO_TOOLS
    );
  }

  markUnused(): void {
    this.divergence ??= {
      turn: this.position,
      reason: DivergeReason.TurnsUnused,
      step: null,
    };
  }

  private write(record: unknown): void {
    try {
      this.output.turn(record);
    } catch (error) {
      this.writeError ??= error;
    }
  }

  private writeMarked(record: object, marked: boolean): void {
    const plain = JSON.parse(JSON.stringify(record)) as object;
    const changed =
      canonicalJSON(this.output.redacted(plain)) !== canonicalJSON(plain);
    this.write(marked || changed ? { ...plain, redacted: true } : plain);
  }

  private diverge(reason: DivergeReason, turn: number): never {
    this.divergence ??= {
      turn,
      reason,
      step: this.output.currentStep,
    };
    this.onDiverged();
    throw new Error(DIVERGED);
  }

  private drift(recorded: SentRequest, sent: SentRequest, turn: number): void {
    recorded.messages.forEach((message, index) => {
      if (canonicalJSON(message) === canonicalJSON(sent.messages[index]))
        return;
      const callId = message.toolCallId as string;
      if (this.drifted.has(callId)) return;
      this.drifted.set(callId, {
        turn,
        step: this.output.currentStep,
        message_index: index,
        tool_call_id: callId,
        tool_name: message.toolName as string,
      });
    });
  }

  private requestOf(model: Model<Api>, messages: readonly object[]): unknown {
    const text = JSON.stringify({
      kind: TurnKind.Request,
      model: { provider: model.provider, id: model.id },
      messages: messages.map(sentPart),
    });
    const redacted = this.output.redacted(
      JSON.parse(
        this.paths.hidden(text).replace(BASH_LOG_PATTERN, BASH_LOG_TOKEN),
      ),
    );
    return JSON.parse(
      JSON.stringify(redacted).replace(SESSION_MARKER_PATTERN, ruleMarker),
    );
  }

  private replayed(request: unknown): AssistantMessageEventStream {
    const turn = this.replay?.turns[this.position];
    const number = this.position + NEXT_TURN;
    if (turn === undefined)
      return this.diverge(DivergeReason.RequestExtra, number);
    if (turn.request !== canonicalJSON(request)) {
      const recorded = JSON.parse(turn.request) as SentRequest;
      const sent = request as SentRequest;
      if (structureOf(recorded) !== structureOf(sent))
        return this.diverge(DivergeReason.RequestDiffers, number);
      this.drift(recorded, sent, number);
    }
    if (turn.redacted)
      return this.diverge(DivergeReason.RedactedRecord, number);
    this.position += NEXT_TURN;
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
        this.writeMarked(
          { kind: TurnKind.Answer, message: this.paths.hide(message) },
          false,
        );
      });
      return stream;
    };
  }

  private recordTool(line: ToolRecord, marked = false): void {
    this.writeMarked({ kind: TurnKind.Tool, ...line }, marked);
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
        result: this.paths.hide({
          content: result.content,
          isError: result.isError,
        }) as ToolLine["result"],
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
    if (recorded === undefined || recorded.name !== name)
      return this.diverge(DivergeReason.ToolUnrecorded, this.position);
    this.replay.tools.delete(callId);
    this.recordTool(
      {
        name: recorded.name,
        call_id: recorded.call_id,
        result: recorded.result,
        error: recorded.error,
      },
      recorded.redacted === true,
    );
    if (recorded.error !== undefined)
      throw new Error(this.paths.show<string>(recorded.error));
    return {
      ...this.paths.show<Omit<AgentToolResult<unknown>, "details">>(
        recorded.result,
      ),
      details: undefined,
    };
  }
}
