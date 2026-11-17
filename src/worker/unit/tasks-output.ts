import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { KNOWN_VALUE_MIN_CHARACTERS } from "../../agent/sensitive-text.ts";
import type { TelemetryRecord } from "../../tracking/contract.ts";
import { tasksDiagnostic, TasksErrorCode } from "./tasks-seed.ts";
import type { TelemetrySink } from "./telemetry.ts";

export const OutputFile = {
  Result: "result.json",
  Context: "context.json",
  Progress: "progress.json",
  Metrics: "metrics.json",
  Outbox: "outbox.json",
  Spans: "spans.jsonl",
} as const;
export const UPLOADS_DIRECTORY = "uploads";
export const STATE_DIRECTORY = "state";
export const REDACTED = "[redacted]";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const JSON_INDENT = 2;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;
const ULID_BASE = 32;
const NO_POSITION = 0;
const NO_BYTES = 0;
const NEWLINE = "\n";
const EVIDENCE_PREFIX = "evidence";
const ASSET_PREFIX = "evidence_asset";
const STRING_TYPE = "string";
const OBJECT_TYPE = "object";
const RUN_MARKERS = [OutputFile.Result, STATE_DIRECTORY];

export interface OutboxEntry {
  operation: string;
  body: unknown;
  step: string | null;
  time: number;
}

export interface SyntheticEvidence {
  evidence_id: string;
  asset_id: string;
}

export interface OutputSecrets {
  credential: readonly string[];
  passed: readonly string[];
}

function ulidOf(position: number): string {
  let rest = position;
  let text = "";
  while (rest > NO_POSITION) {
    text = `${ULID_ALPHABET[rest % ULID_BASE]}${text}`;
    rest = Math.floor(rest / ULID_BASE);
  }
  return text.padStart(ULID_LENGTH, ULID_ALPHABET[NO_POSITION]);
}

function jsonValue(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Map) return Object.fromEntries(entry);
    if (entry instanceof Set) return [...entry];
    return entry;
  });
  return text === undefined ? null : JSON.parse(text);
}

function redactText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result;
}

function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === STRING_TYPE) return redactText(value as string, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactJson(item, secrets));
  if (value === null || typeof value !== OBJECT_TYPE) return value;
  return Object.fromEntries(
    Object.entries(value as object).map(([key, item]) => [
      redactText(key, secrets),
      redactJson(item, secrets),
    ]),
  );
}

function redactBytes(bytes: Buffer, secrets: readonly string[]): Buffer {
  let result = bytes;
  for (const secret of secrets) {
    const needle = Buffer.from(secret, "utf8");
    const parts: Buffer[] = [];
    let start = NO_BYTES;
    for (
      let found = result.indexOf(needle, start);
      found >= NO_BYTES;
      found = result.indexOf(needle, start)
    ) {
      parts.push(result.subarray(start, found), Buffer.from(REDACTED));
      start = found + needle.length;
    }
    parts.push(result.subarray(start));
    result = Buffer.concat(parts);
  }
  return result;
}

function isRunFolder(folder: string): boolean {
  const entries = readdirSync(folder);
  return (
    entries.length === NO_BYTES ||
    RUN_MARKERS.some((marker) => entries.includes(marker))
  );
}

export function checkOutputFolder(folder: string, force: boolean): void {
  if (!existsSync(folder)) return;
  if (force && isRunFolder(folder)) return;
  throw tasksDiagnostic(
    TasksErrorCode.OutputExists,
    "worker tasks run: the output folder exists; pass --force to replace an earlier run folder.",
    [["output", folder]],
  );
}

export class TasksOutput {
  readonly folder: string;
  readonly state: string;
  private readonly secrets: readonly string[];
  private readonly entries: OutboxEntry[] = [];
  private readonly records: TelemetryRecord[] = [];
  private readonly logLine: (line: string) => void;
  private evidenceCount = NO_POSITION;

  private constructor(
    folder: string,
    secrets: readonly string[],
    logLine: (line: string) => void,
  ) {
    this.folder = folder;
    this.state = join(folder, STATE_DIRECTORY);
    this.secrets = secrets;
    this.logLine = logLine;
  }

  static create(
    folder: string,
    secrets: OutputSecrets,
    logLine: (line: string) => void,
  ): TasksOutput {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const output = new TasksOutput(
      folder,
      [
        ...secrets.credential.filter(Boolean),
        ...secrets.passed.filter(
          (value) => value.length >= KNOWN_VALUE_MIN_CHARACTERS,
        ),
      ],
      logLine,
    );
    for (const directory of [UPLOADS_DIRECTORY, STATE_DIRECTORY])
      output.directory(directory);
    output.writeJson(OutputFile.Outbox, []);
    writeFileSync(join(folder, OutputFile.Spans), "", {
      mode: PRIVATE_FILE_MODE,
    });
    return output;
  }

  directory(...parts: string[]): string {
    const path = join(this.folder, ...parts);
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    return path;
  }

  redacted(value: unknown): unknown {
    return redactJson(jsonValue(value), this.secrets);
  }

  redactedText(text: string): string {
    return redactText(text, this.secrets);
  }

  writeJson(name: string, value: unknown): void {
    writeFileSync(
      join(this.folder, name),
      `${JSON.stringify(this.redacted(value), null, JSON_INDENT)}${NEWLINE}`,
      { mode: PRIVATE_FILE_MODE },
    );
  }

  record(entry: Omit<OutboxEntry, "time">): void {
    this.entries.push({ ...entry, time: Date.now() });
    this.writeJson(OutputFile.Outbox, this.entries);
  }

  outbox(): readonly OutboxEntry[] {
    return this.entries;
  }

  nextEvidence(): SyntheticEvidence {
    this.evidenceCount += 1;
    const suffix = ulidOf(this.evidenceCount);
    return {
      evidence_id: `${EVIDENCE_PREFIX}_${suffix}`,
      asset_id: `${ASSET_PREFIX}_${suffix}`,
    };
  }

  upload(evidence: SyntheticEvidence, bytes: Buffer): void {
    writeFileSync(
      join(
        this.directory(UPLOADS_DIRECTORY, evidence.evidence_id),
        evidence.asset_id,
      ),
      redactBytes(bytes, this.secrets),
      { mode: PRIVATE_FILE_MODE },
    );
  }

  log(record: Record<string, unknown>): void {
    this.logLine(`${JSON.stringify(this.redacted(record))}${NEWLINE}`);
  }

  spans(): readonly TelemetryRecord[] {
    return this.records;
  }

  telemetry(): TelemetrySink {
    return {
      write: (records) => {
        const redacted = records.map(
          (record) => this.redacted(record) as TelemetryRecord,
        );
        this.records.push(...redacted);
        appendFileSync(
          join(this.folder, OutputFile.Spans),
          redacted
            .map((record) => `${JSON.stringify(record)}${NEWLINE}`)
            .join(""),
        );
      },
      flush: async () => {},
    };
  }
}
