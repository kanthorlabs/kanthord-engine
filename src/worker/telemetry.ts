import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RecordKind,
  SpanStatus,
  type Attributes,
  type TelemetryRecord,
} from "../tracking/contract.ts";

export interface TelemetrySink {
  write(records: readonly TelemetryRecord[]): void;
  flush(timeoutMs: number): Promise<void>;
}
export const noTelemetry: TelemetrySink = {
  write: () => {},
  flush: async () => {},
};

export const SpanOperation = {
  Phase: "worker.phase",
  Task: "worker.task",
  Verification: "worker.verification",
  Judgement: "worker.judgement",
  Evaluation: "worker.evaluation",
  Turn: "agent.turn",
  Tool: "agent.tool",
} as const;
export type SpanOperation = (typeof SpanOperation)[keyof typeof SpanOperation];

export const Phase = {
  Prepare: "prepare",
  Start: "start",
  Tasks: "tasks",
  Finish: "finish",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export interface SpanClaim {
  execution_id: string;
  node_id: string;
  attempt: number;
  trace_id: string;
  root_span_id: string;
}
export type Texts = Readonly<Record<string, string>>;
export interface SpanStart {
  key: string;
  operation: SpanOperation;
  parent?: string;
  attributes?: Attributes;
  texts?: Texts;
}
export interface SpanEnd {
  status: typeof SpanStatus.Ok | typeof SpanStatus.Error;
  attributes?: Attributes;
  texts?: Texts;
}

const SPAN_ID_LENGTH = 16;
const TEXT_PART_CHARACTERS = 15000;
const TEXT_PARTS_MAX = 8;
const FIRST_PART = 1;
const ZERO_SPAN = /^0+$/;
const NO_FAULTS = 0;
const SPAN_PATTERN = /^[0-9a-f]{16}$/;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const TEXT_NAME = /^[a-z][a-z0-9_]*$/;

interface OpenSpan {
  operation: SpanOperation;
  parent: string;
}

export function telemetrySpanId(executionId: string, key: string): string {
  assert.ok(executionId);
  assert.ok(key);
  const id = createHash("sha256")
    .update(`${executionId}:${key}`, "utf8")
    .digest("hex")
    .slice(0, SPAN_ID_LENGTH);
  assert.ok(!ZERO_SPAN.test(id), "a span identity is never all zero");
  return id;
}

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST;
}

function textParts(text: string): string[] {
  assert.ok(TEXT_PARTS_MAX > FIRST_PART);
  assert.ok(text.isWellFormed());
  if (text.length <= TEXT_PART_CHARACTERS) return [text];
  const parts: string[] = [];
  for (
    let offset = 0;
    offset < text.length && parts.length < TEXT_PARTS_MAX;
    offset += parts.at(-1)!.length
  ) {
    const end = Math.min(offset + TEXT_PART_CHARACTERS, text.length);
    const cut =
      end < text.length && isHighSurrogate(text.charCodeAt(end - FIRST_PART))
        ? end - FIRST_PART
        : end;
    parts.push(text.slice(offset, cut));
  }
  assert.ok(parts.length <= TEXT_PARTS_MAX);
  return parts;
}

export class SpanRecorder {
  private readonly claim: SpanClaim;
  private readonly sink: TelemetrySink;
  private readonly identity: Attributes;
  private readonly open = new Map<string, OpenSpan>();
  private readonly scopes: string[] = [];
  private turns = 0;
  private faults = NO_FAULTS;
  private readonly counters = new Map<string, number>();

  constructor(claim: SpanClaim, workerName: string, sink: TelemetrySink) {
    assert.ok(claim.root_span_id);
    assert.ok(workerName);
    this.claim = claim;
    this.sink = sink;
    this.identity = {
      "kanthord.execution.id": claim.execution_id,
      "kanthord.node.id": claim.node_id,
      "kanthord.attempt": claim.attempt,
      "kanthord.worker.name": workerName,
    };
  }

  current(): string {
    const spanId = this.scopes.at(-1) ?? this.claim.root_span_id;
    assert.match(spanId, SPAN_PATTERN);
    assert.ok(this.scopes.length <= this.open.size);
    return spanId;
  }

  nextTurn(): number {
    this.turns += 1;
    assert.ok(Number.isSafeInteger(this.turns));
    assert.ok(this.turns > NO_FAULTS);
    return this.turns;
  }

  fault(): void {
    this.faults += 1;
    assert.ok(Number.isSafeInteger(this.faults));
    assert.ok(this.faults > NO_FAULTS);
  }

  faultCount(): number {
    assert.ok(Number.isSafeInteger(this.faults));
    assert.ok(this.faults >= NO_FAULTS);
    return this.faults;
  }

  key(prefix: string): string {
    assert.ok(prefix);
    const count = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, count);
    assert.ok(Number.isSafeInteger(count));
    return `${prefix}:${count}`;
  }

  start(span: SpanStart): string {
    assert.ok(span.key);
    assert.ok(span.operation);
    const spanId = telemetrySpanId(this.claim.execution_id, span.key);
    const parent = span.parent ?? this.current();
    this.open.set(spanId, { operation: span.operation, parent });
    const texts = this.textRecords(spanId, span.texts ?? {});
    this.sink.write([
      ...texts.records,
      {
        record_id: `${spanId}:start`,
        trace_id: this.claim.trace_id,
        kind: RecordKind.Span,
        span_id: spanId,
        operation: span.operation,
        parent_span_id: parent,
        start_time: Date.now(),
        attributes: { ...this.identity, ...span.attributes },
        text_ids: texts.ids,
      },
    ]);
    return spanId;
  }

  end(spanId: string, end: SpanEnd): void {
    const open = this.open.get(spanId);
    assert.ok(open, "a span ends after its start");
    assert.ok(end.status);
    this.open.delete(spanId);
    const texts = this.textRecords(spanId, end.texts ?? {});
    this.sink.write([
      ...texts.records,
      {
        record_id: `${spanId}:end`,
        trace_id: this.claim.trace_id,
        kind: RecordKind.Span,
        span_id: spanId,
        operation: open.operation,
        parent_span_id: open.parent,
        end_time: Date.now(),
        status: end.status,
        attributes: end.attributes ?? {},
        text_ids: texts.ids,
      },
    ]);
  }

  async within<T>(
    span: SpanStart,
    work: (spanId: string) => Promise<T>,
    endOf: (result: T) => SpanEnd = () => ({ status: SpanStatus.Ok }),
  ): Promise<T> {
    assert.ok(work);
    assert.ok(endOf);
    const spanId = this.start(span);
    this.scopes.push(spanId);
    let result: T;
    try {
      result = await work(spanId);
    } catch (error) {
      this.end(spanId, { status: SpanStatus.Error });
      throw error;
    } finally {
      assert.equal(this.scopes.pop(), spanId);
    }
    this.end(spanId, endOf(result));
    return result;
  }

  flush(timeoutMs: number): Promise<void> {
    assert.ok(Number.isSafeInteger(timeoutMs));
    assert.ok(this.sink);
    return this.sink.flush(timeoutMs);
  }

  private textRecords(
    spanId: string,
    texts: Texts,
  ): { records: TelemetryRecord[]; ids: string[] } {
    assert.match(spanId, SPAN_PATTERN);
    assert.ok(texts);
    const records: TelemetryRecord[] = [];
    for (const [name, text] of Object.entries(texts)) {
      assert.match(name, TEXT_NAME);
      if (!text) continue;
      const parts = textParts(text.toWellFormed());
      const single = parts.length === FIRST_PART;
      parts.forEach((part, index) => {
        const textId = single
          ? `${spanId}:${name}`
          : `${spanId}:${name}.${index + FIRST_PART}`;
        records.push({
          record_id: textId,
          trace_id: this.claim.trace_id,
          kind: RecordKind.Text,
          text_id: textId,
          text: part,
        });
      });
    }
    return {
      records,
      ids: records.map((record) =>
        record.kind === RecordKind.Text ? record.text_id : record.record_id,
      ),
    };
  }
}
