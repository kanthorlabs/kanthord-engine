import { cpSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import pino from "pino";
import { diagnostic, diagnosticRows } from "./errors.ts";
import { redaction } from "./log.ts";

export function diagnosticText(error: unknown): string {
  return `${diagnostic(error)}\n${diagnosticRows(error)}`;
}

export function redactingLogger(lines: string[]): pino.Logger {
  return pino({ redact: redaction }, { write: (line) => lines.push(line) });
}

export function temporaryDirectory(): string {
  process.umask(0o077);
  const parent = join(tmpdir(), "opencode");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, "kanthord-"));
}

export function temporary(t: TestContext): string {
  const path = temporaryDirectory();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

export function fixtureTemplate<T>(
  build: (root: string) => Promise<T>,
): (t: TestContext) => Promise<{ root: string; built: T }> {
  let template: Promise<{ root: string; built: T }> | undefined;
  return async (t) => {
    template ??= (async () => {
      const root = temporaryDirectory();
      process.on("exit", () => rmSync(root, { recursive: true, force: true }));
      return { root, built: await build(root) };
    })();
    const { root, built } = await template;
    const copy = temporary(t);
    cpSync(root, copy, { recursive: true });
    return { root: copy, built };
  };
}

export function hostEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export const UNSET_GIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  GIT_CONFIG_GLOBAL: undefined,
  GIT_CONFIG_NOSYSTEM: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_ATTR_NOSYSTEM: undefined,
} as const;

export function overrideEnvironment(
  t: TestContext,
  values: Record<string, string | undefined>,
): void {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(entries))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
  apply(values);
  t.after(() => apply(previous));
}

const PROCESS_ABSENT = "ESRCH";

export function killIfPresent(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === PROCESS_ABSENT
    ))
      throw error;
  }
}
