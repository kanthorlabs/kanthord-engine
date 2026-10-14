import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
export function temporary(t: TestContext): string {
  process.umask(0o077);
  const parent = join(tmpdir(), "opencode");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(parent, "kanthord-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

export function hostEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}

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
