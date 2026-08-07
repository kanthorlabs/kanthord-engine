import type { OutcomeState } from "./idempotency-record.ts";
import type { StoredAnswer } from "./idempotency-response.ts";

export type IdempotencySettings = Readonly<{
  ttlSeconds: number;
  joinTimeoutSeconds: number;
  maxEntries: number;
  maxBytes: number;
}>;

export const defaultIdempotencySettings: IdempotencySettings = {
  ttlSeconds: 300,
  joinTimeoutSeconds: 30,
  maxEntries: 256,
  maxBytes: 8388608,
};

export type Schedule = (
  milliseconds: number,
  callback: () => void,
) => () => void;

export type JoinOutcome =
  | Readonly<{ kind: "answer"; answer: StoredAnswer }>
  | Readonly<{ kind: "timeout" }>;

export type ReserveResult =
  | Readonly<{
      kind: "reserved";
      settle: (answer: StoredAnswer, state: OutcomeState) => void;
    }>
  | Readonly<{ kind: "joined"; outcome: Promise<JoinOutcome> }>
  | Readonly<{ kind: "replay"; answer: StoredAnswer }>
  | Readonly<{ kind: "mismatch" }>
  | Readonly<{ kind: "saturated" }>;

export type StoreInput = Readonly<{
  settings: IdempotencySettings;
  now: () => number;
  schedule: Schedule;
}>;

type Record_ = {
  fingerprint: string;
  seq: number;
  expiresAt: number | null;
  answer: StoredAnswer | null;
  waiters: ((answer: StoredAnswer) => void)[];
  bytes: number;
  settled: boolean;
};

function answerBytes(answer: StoredAnswer): number {
  let body: string;
  try {
    body = JSON.stringify(answer.body ?? null) ?? "null";
  } catch {
    body = "";
  }
  return (
    Buffer.byteLength(body, "utf8") +
    Buffer.byteLength(JSON.stringify(answer.headers), "utf8")
  );
}

export class IdempotencyStore {
  private readonly settings: IdempotencySettings;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly records = new Map<string, Record_>();
  private nextSeq = 0;
  private totalBytes = 0;

  constructor(input: StoreInput) {
    this.settings = input.settings;
    this.now = input.now;
    this.schedule = input.schedule;
  }

  reserve(recordKey: string, fingerprint: string): ReserveResult {
    this.sweep();
    const record = this.records.get(recordKey);
    if (record !== undefined && record.expiresAt === null) {
      if (record.fingerprint !== fingerprint) {
        return { kind: "mismatch" };
      }
      return { kind: "joined", outcome: this.join(record) };
    }

    if (record !== undefined && record.expiresAt !== null) {
      if (record.fingerprint !== fingerprint) {
        return { kind: "mismatch" };
      }
      return { kind: "replay", answer: record.answer as StoredAnswer };
    }

    const incoming =
      Buffer.byteLength(recordKey, "utf8") +
      Buffer.byteLength(fingerprint, "utf8");
    if (!this.makeRoom(incoming)) {
      return { kind: "saturated" };
    }

    const created: Record_ = {
      fingerprint,
      seq: this.nextSeq++,
      expiresAt: null,
      answer: null,
      waiters: [],
      settled: false,
      bytes:
        Buffer.byteLength(recordKey, "utf8") +
        Buffer.byteLength(fingerprint, "utf8"),
    };
    this.records.set(recordKey, created);
    this.totalBytes += created.bytes;

    const settle = (answer: StoredAnswer, state: OutcomeState): void => {
      if (this.records.get(recordKey) !== created || created.settled) {
        return;
      }
      created.settled = true;
      for (const waiter of created.waiters.splice(0)) {
        waiter(answer);
      }
      if (state === "uncacheable") {
        this.records.delete(recordKey);
        this.totalBytes -= created.bytes;
        return;
      }
      const incoming = answerBytes(answer);
      if (this.totalBytes + incoming > this.settings.maxBytes) {
        this.evictCompletedUntil(incoming);
      }
      if (this.totalBytes + incoming > this.settings.maxBytes) {
        this.records.delete(recordKey);
        this.totalBytes -= created.bytes;
        return;
      }
      created.answer = answer;
      created.expiresAt = this.now() + this.settings.ttlSeconds * 1000;
      created.bytes += incoming;
      this.totalBytes += incoming;
    };

    return { kind: "reserved", settle };
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt !== null && record.expiresAt <= now) {
        this.records.delete(key);
        this.totalBytes -= record.bytes;
      }
    }
  }

  private makeRoom(incoming: number): boolean {
    for (;;) {
      const overEntries = this.records.size + 1 > this.settings.maxEntries;
      const overBytes = this.totalBytes + incoming > this.settings.maxBytes;
      if (!overEntries && !overBytes) {
        return true;
      }
      const victim = this.oldestCompleted();
      if (victim === null) {
        return false;
      }
      const record = this.records.get(victim) as Record_;
      this.records.delete(victim);
      this.totalBytes -= record.bytes;
    }
  }

  private evictCompletedUntil(incoming: number): void {
    for (;;) {
      if (this.totalBytes + incoming <= this.settings.maxBytes) {
        return;
      }
      const victim = this.oldestCompleted();
      if (victim === null) {
        return;
      }
      const record = this.records.get(victim) as Record_;
      this.records.delete(victim);
      this.totalBytes -= record.bytes;
    }
  }

  private oldestCompleted(): string | null {
    let bestKey: string | null = null;
    let bestExpiresAt = 0;
    let bestSeq = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt === null) continue;
      if (
        bestKey === null ||
        record.expiresAt < bestExpiresAt ||
        (record.expiresAt === bestExpiresAt && record.seq < bestSeq)
      ) {
        bestKey = key;
        bestExpiresAt = record.expiresAt;
        bestSeq = record.seq;
      }
    }
    return bestKey;
  }

  private join(record: Record_): Promise<JoinOutcome> {
    return new Promise((resolve) => {
      const waiter = (answer: StoredAnswer): void => {
        cancel?.();
        resolve({ kind: "answer", answer });
      };
      record.waiters.push(waiter);
      let cancel: (() => void) | undefined;
      if (this.settings.joinTimeoutSeconds > 0) {
        cancel = this.schedule(this.settings.joinTimeoutSeconds * 1000, () => {
          const at = record.waiters.indexOf(waiter);
          if (at >= 0) record.waiters.splice(at, 1);
          resolve({ kind: "timeout" });
        });
      }
    });
  }

  size(): number {
    return this.records.size;
  }

  bytes(): number {
    return this.totalBytes;
  }

  waiters(recordKey: string): number {
    return this.records.get(recordKey)?.waiters.length ?? 0;
  }
}
