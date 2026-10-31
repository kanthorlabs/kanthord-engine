import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import pino from "pino";
import {
  PI_TOOLS_MANIFEST,
  piToolAsset,
  piToolCurrent,
  shippedAsset,
} from "./assets.ts";
import { CancellationContext } from "./context.ts";
import { diagnostic, diagnosticRows } from "./errors.ts";
import { redaction } from "./log.ts";
import { stopAfter } from "./stop-test-support.ts";

export { stopAfter };

export const SUITE_CONCURRENCY = 4;

interface PiToolsDigests {
  tools: Record<string, { targets: Record<string, { binary_sha256: string }> }>;
}

export function requirePiTools(
  options: { directory?: URL; manifest?: PiToolsDigests } = {},
): void {
  const manifest =
    options.manifest ??
    (JSON.parse(shippedAsset(PI_TOOLS_MANIFEST)) as PiToolsDigests);
  const target = `${process.platform}-${process.arch}`;
  const refused = Object.entries(manifest.tools)
    .filter(([tool, definition]) => {
      const entry = definition.targets[target];
      const binary = piToolAsset(
        target,
        `bin/${tool}`,
        undefined,
        options.directory,
      );
      return !entry || !binary || !piToolCurrent(binary, entry.binary_sha256);
    })
    .map(([tool]) => tool);
  if (refused.length)
    assert.fail(
      `pi tools are absent or stale: ${refused.join(", ")}. Run pnpm run pi-tools:fetch before this test.`,
    );
}

export function diagnosticText(error: unknown): string {
  return `${diagnostic(error)}\n${diagnosticRows(error)}`;
}

export function redactingLogger(lines: string[]): pino.Logger {
  return pino({ redact: redaction }, { write: (line) => lines.push(line) });
}

export async function childRun(
  file: string,
  args: string[],
  options: { signal: AbortSignal; input?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(file, args, { signal: options.signal });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.end(options.input);
  const [status] = (await once(child, "close")) as [number | null];
  return { status, stdout, stderr };
}

export function testContext(t: TestContext): CancellationContext {
  const context = new CancellationContext();
  const cancel = () => context.cancel(t.signal.reason);
  t.signal.addEventListener("abort", cancel, { once: true });
  stopAfter(t, () => {
    t.signal.removeEventListener("abort", cancel);
    context.cancel();
  });
  return context;
}

export function temporaryDirectory(): string {
  process.umask(0o077);
  const parent = join(tmpdir(), "opencode");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, "kanthord-"));
}

export function temporary(t: TestContext): string {
  const path = temporaryDirectory();
  stopAfter(t, () => rmSync(path, { recursive: true, force: true }));
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
  stopAfter(t, () => apply(previous));
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
