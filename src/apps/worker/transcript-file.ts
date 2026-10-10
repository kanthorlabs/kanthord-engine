import {
  appendFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDirectory } from "../../kernel/files.ts";
import { identitySchema } from "../../kernel/identity.ts";
import type { TranscriptSink } from "../../worker/index.ts";

export const TRANSCRIPT_RETENTION = 50;
const TRANSCRIPT_DIRECTORY = "transcripts";
const TRANSCRIPT_EXTENSION = ".jsonl";
const PRIVATE_FILE_MODE = 0o600;

function prune(directory: string, keep: string): void {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(TRANSCRIPT_EXTENSION))
    .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
    .toSorted((left, right) => right.mtime - left.mtime);
  for (const file of files.slice(TRANSCRIPT_RETENTION))
    if (file.name !== keep) unlinkSync(join(directory, file.name));
}

export function fileTranscript(stateDirectory: string): TranscriptSink {
  const directory = join(stateDirectory, TRANSCRIPT_DIRECTORY);
  return {
    record(entry) {
      ensureDirectory(directory);
      const name = `${identitySchema("execution").parse(entry.executionId)}${TRANSCRIPT_EXTENSION}`;
      const path = join(directory, name);
      const fresh = !existsSync(path);
      appendFileSync(path, `${JSON.stringify(entry)}\n`, {
        mode: PRIVATE_FILE_MODE,
      });
      if (fresh) prune(directory, name);
    },
  };
}
