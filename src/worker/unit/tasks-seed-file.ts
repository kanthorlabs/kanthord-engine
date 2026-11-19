import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { digest } from "../../kernel/json.ts";
import { withoutEnvironmentMaps } from "../contract.ts";
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
const TEMPORARY_PREFIX = ".seed-";
const EXCLUSIVE_WRITE = "wx";

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

function refuseSymbolicLink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
    throw tasksDiagnostic(
      TasksErrorCode.OutputExists,
      "worker tasks seed: the output folder or seed.json is a symbolic link.",
      [["output", path]],
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
  const seed = {
    ...parsed.data,
    setup: withoutEnvironmentMaps(parsed.data.setup),
  };
  refuseSymbolicLink(folder);
  mkdirSync(folder, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(folder, PRIVATE_DIRECTORY_MODE);
  const file = join(folder, SEED_FILE);
  refuseSymbolicLink(file);
  const temporary = join(folder, `${TEMPORARY_PREFIX}${randomUUID()}`);
  writeFileSync(
    temporary,
    `${JSON.stringify(seed, null, JSON_INDENT)}${NEWLINE}`,
    {
      mode: PRIVATE_FILE_MODE,
      flag: EXCLUSIVE_WRITE,
    },
  );
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return digest(seed);
}
