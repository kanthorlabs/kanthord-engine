import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type E2eEnv = Readonly<{
  ghToken: string;
  ghRepo: string;
  ghBaseBranch: string;
  runId: string;
}>;

export const E2E_ENV_FILE = ".env.e2e";

export const E2E_REQUIRED_KEYS = [
  "E2E_GH_TOKEN",
  "E2E_GH_REPO",
  "E2E_GH_BASE_BRANCH",
] as const;

export class E2eEnvError extends Error {
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[]) {
    super(message);
    this.name = "E2eEnvError";
    this.missing = missing;
  }
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function parseDotEnv(text: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimStart();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    if (key === "") {
      continue;
    }
    result[key] = line.slice(equalsIndex + 1);
  }
  return result;
}

export function loadE2eFileValues(
  overrides?: Readonly<{ file?: string }>,
): Readonly<Record<string, string>> {
  const file = overrides?.file ?? resolve(process.cwd(), E2E_ENV_FILE);
  if (!existsSync(file)) {
    return {};
  }
  return parseDotEnv(readFileSync(file, "utf8"));
}

export function loadE2eEnv(
  overrides?: Readonly<{ file?: string; runId?: string }>,
): E2eEnv {
  const file =
    overrides?.file ?? resolve(import.meta.dirname, "../..", E2E_ENV_FILE);
  if (!existsSync(file)) {
    throw new E2eEnvError(
      `${file} is absent; the end-to-end gate needs a real remote`,
      E2E_REQUIRED_KEYS,
    );
  }
  const values = parseDotEnv(readFileSync(file, "utf8"));
  const missing = E2E_REQUIRED_KEYS.filter((key) => {
    const value = values[key];
    return value === undefined || value === "";
  });
  if (missing.length > 0) {
    throw new E2eEnvError(`${file} is missing: ${missing.join(", ")}`, missing);
  }
  const ghRepo = requiredValue(values, "E2E_GH_REPO", file);
  if (!REPOSITORY_PATTERN.test(ghRepo)) {
    throw new E2eEnvError(`${file} names an invalid E2E_GH_REPO: ${ghRepo}`, [
      "E2E_GH_REPO",
    ]);
  }
  const ghBaseBranch = requiredValue(values, "E2E_GH_BASE_BRANCH", file);
  if (ghBaseBranch.includes("/") || ghBaseBranch.includes("*")) {
    throw new E2eEnvError(
      `${file} names an unsafe E2E_GH_BASE_BRANCH: ${ghBaseBranch}`,
      ["E2E_GH_BASE_BRANCH"],
    );
  }
  const runId = overrides?.runId ?? process.env.E2E_RUN_ID;
  if (runId === undefined || runId === "") {
    throw new E2eEnvError("E2E_RUN_ID is not set; the gate driver mints it", [
      "E2E_RUN_ID",
    ]);
  }
  return {
    ghToken: requiredValue(values, "E2E_GH_TOKEN", file),
    ghRepo,
    ghBaseBranch,
    runId,
  };
}

function requiredValue(
  values: Readonly<Record<string, string>>,
  key: string,
  file: string,
): string {
  const value = values[key];
  if (value === undefined || value === "") {
    throw new E2eEnvError(`${file} is missing: ${key}`, [key]);
  }
  return value;
}
