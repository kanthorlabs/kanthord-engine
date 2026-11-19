import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { digest } from "../../kernel/json.ts";
import {
  SEED_FILE,
  seedSchema,
  tasksDiagnostic,
  TasksErrorCode,
} from "./tasks-seed.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const JSON_INDENT = 2;
const NEWLINE = "\n";

function isSeedFolder(folder: string): boolean {
  return readdirSync(folder).every((entry) => entry === SEED_FILE);
}

export function checkSeedFolder(folder: string, force: boolean): void {
  if (!existsSync(folder)) return;
  if (force && isSeedFolder(folder)) return;
  throw tasksDiagnostic(
    TasksErrorCode.OutputExists,
    "worker tasks seed: the output folder exists; pass --force to replace an earlier seed folder.",
    [["output", folder]],
  );
}

export function writeSeed(folder: string, value: unknown): string {
  const parsed = seedSchema.safeParse(value);
  if (!parsed.success)
    throw tasksDiagnostic(
      TasksErrorCode.SeedInvalid,
      "worker tasks seed: the seed fails the seed schema.",
      [
        [
          "paths",
          [
            ...new Set(parsed.error.issues.map(({ path }) => path.join("."))),
          ].join(", "),
        ],
      ],
    );
  mkdirSync(folder, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(folder, PRIVATE_DIRECTORY_MODE);
  const file = join(folder, SEED_FILE);
  writeFileSync(file, `${JSON.stringify(value, null, JSON_INDENT)}${NEWLINE}`, {
    mode: PRIVATE_FILE_MODE,
  });
  chmodSync(file, PRIVATE_FILE_MODE);
  return digest(value);
}
