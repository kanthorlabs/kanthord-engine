import { relative, resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Context } from "../../kernel/context.ts";
import { isString } from "../../kernel/values.ts";
import { includePaths, untrackedPaths } from "./local-git.ts";

const OWNING_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);
const READ_LIMIT_MS = 30000;

export interface VerificationScope {
  commands: readonly string[];
  checkouts: readonly string[];
}

export interface VerificationInput extends VerificationScope {
  env: NodeJS.ProcessEnv;
  context: Context;
  workspace: string;
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

  isVerification(command: string): boolean {
    return this.commands.has(command.trim());
  }

  async observe<T>(run: () => Promise<T>): Promise<T> {
    const before = await this.untracked();
    try {
      return await run();
    } finally {
      const after = await this.untracked();
      for (const [directory, paths] of after)
        this.record(directory, this.newPaths(before.get(directory), paths));
    }
  }

  pathsOf(directory: string): string[] {
    return [...(this.written.get(directory) ?? [])];
  }

  ownership(): InlineExtension {
    return (pi) => {
      pi.on("tool_call", async (event) => {
        if (!OWNING_TOOLS.has(event.toolName)) return undefined;
        const { path } = event.input as { path?: unknown };
        if (isString(path)) await this.release(resolve(this.workspace, path));
        return undefined;
      });
    };
  }

  private newPaths(
    before: ReadonlySet<string> | undefined,
    after: ReadonlySet<string>,
  ): string[] {
    return [...after].filter((path) => !before?.has(path));
  }

  private record(directory: string, added: readonly string[]): void {
    const paths = this.written.get(directory) ?? new Set<string>();
    for (const path of added) paths.add(path);
    this.written.set(directory, paths);
  }

  private async release(absolute: string): Promise<void> {
    for (const [directory, paths] of this.written) {
      const path = relative(directory, absolute);
      if (!paths.delete(path)) continue;
      await includePaths(
        {
          env: this.env,
          directory,
          context: this.context,
          deadlineMs: READ_LIMIT_MS,
        },
        [path],
      );
    }
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
            deadlineMs: READ_LIMIT_MS,
          }),
        ),
      );
    return read;
  }
}
