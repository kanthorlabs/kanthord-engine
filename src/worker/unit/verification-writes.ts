import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Context } from "../../kernel/context.ts";
import { isString } from "../../kernel/values.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import { untrackedPaths } from "./local-git.ts";

const OWNING_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);
const MISSING = "missing";
const GIT_DIRECTORY = ".git";
const NO_PATHS = 0;

export interface VerificationScope {
  commands: readonly string[];
  checkouts: readonly string[];
}

export interface VerificationInput extends VerificationScope {
  env: NodeJS.ProcessEnv;
  context: Context;
  workspace: string;
}

function digestOf(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function fingerprintOf(path: string): string | undefined {
  try {
    return readFingerprint(path);
  } catch {
    return undefined;
  }
}

function readFingerprint(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return MISSING;
  const header = `${stat.size}:${stat.mtimeMs}`;
  if (stat.isSymbolicLink()) return `${header}:${digestOf(readlinkSync(path))}`;
  if (stat.isFile()) return `${header}:${fileDigest(path, stat)}`;
  if (!stat.isDirectory()) return header;
  const entries = readdirSync(path)
    .filter((name) => name !== GIT_DIRECTORY)
    .sort()
    .map((name) => `${name}=${readFingerprint(join(path, name))}`);
  return `${header}:${digestOf(entries.join("\n"))}`;
}

function fileDigest(path: string, stat: Stats): string {
  try {
    return digestOf(readFileSync(path));
  } catch {
    return `${stat.ctimeMs}:${stat.ino}:${stat.mode}`;
  }
}

function unchanged(before: string | undefined, now: string | undefined) {
  return before !== undefined && before === now;
}

function contains(recorded: string, changed: string): boolean {
  return changed === recorded || changed.startsWith(`${recorded}/`);
}

function newPaths(
  before: ReadonlyMap<string, ReadonlySet<string>>,
  after: ReadonlyMap<string, ReadonlySet<string>>,
): [string, string][] {
  return [...after].flatMap(([directory, paths]) =>
    [...paths]
      .filter((path) => !before.get(directory)?.has(path))
      .map((path): [string, string] => [directory, path]),
  );
}

function isNestedRepository(absolute: string): boolean {
  return existsSync(join(absolute, GIT_DIRECTORY));
}

function releasable(
  directory: string,
  paths: ReadonlySet<string>,
  changed: string,
): string[] {
  return [...paths].filter(
    (path) =>
      contains(path, changed) && !isNestedRepository(join(directory, path)),
  );
}

export class VerificationWrites {
  private readonly commands: ReadonlySet<string>;
  private readonly checkouts: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly context: Context;
  private readonly workspace: string;
  private readonly written = new Map<string, Set<string>>();

  constructor(input: VerificationInput) {
    this.commands = new Set(input.commands.map((command) => command.trim()));
    this.checkouts = input.checkouts;
    this.env = input.env;
    this.context = input.context;
    this.workspace = input.workspace;
  }

  track<T>(command: string, run: () => Promise<T>): Promise<T> {
    return this.commands.has(command.trim())
      ? this.observe(run)
      : this.guard(run);
  }

  pathsOf(directory: string): string[] {
    return [...(this.written.get(directory) ?? [])];
  }

  ownership(): InlineExtension {
    return (pi) => {
      pi.on("tool_call", (event) => {
        if (!OWNING_TOOLS.has(event.toolName)) return undefined;
        const { path } = event.input as { path?: unknown };
        if (isString(path)) this.release(resolve(this.workspace, path));
        return undefined;
      });
    };
  }

  private async observe<T>(run: () => Promise<T>): Promise<T> {
    const before = await this.untracked();
    try {
      return await run();
    } finally {
      const after = await this.untracked();
      for (const [directory, path] of newPaths(before, after))
        this.record(directory, path);
    }
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    const before = this.fingerprints();
    if (before.size === NO_PATHS) return run();
    try {
      return await run();
    } finally {
      this.releaseChanged(before);
    }
  }

  private releaseChanged(
    before: ReadonlyMap<string, string | undefined>,
  ): void {
    for (const [absolute, fingerprint] of before)
      if (!unchanged(fingerprint, fingerprintOf(absolute)))
        this.release(absolute);
  }

  private fingerprints(): Map<string, string | undefined> {
    const read = new Map<string, string | undefined>();
    for (const [directory, paths] of this.written)
      for (const path of paths)
        read.set(join(directory, path), fingerprintOf(join(directory, path)));
    return read;
  }

  private record(directory: string, path: string): void {
    const paths = this.written.get(directory) ?? new Set<string>();
    paths.add(path);
    this.written.set(directory, paths);
  }

  private release(absolute: string): void {
    for (const [directory, paths] of this.written)
      for (const path of releasable(
        directory,
        paths,
        relative(directory, absolute),
      ))
        paths.delete(path);
  }

  private async untracked(): Promise<Map<string, Set<string>>> {
    const read = new Map<string, Set<string>>();
    for (const directory of this.checkouts)
      read.set(
        directory,
        new Set(
          await untrackedPaths({
            env: this.env,
            directory,
            context: this.context,
            deadlineMs: COMMAND_LIMIT_MS,
          }),
        ),
      );
    return read;
  }
}
