export interface TranscriptSink {
  record(entry: {
    executionId: string;
    attempt: number;
    traceId: string;
    messages: readonly unknown[];
  }): void;
}

export const noTranscript: TranscriptSink = { record() {} };
