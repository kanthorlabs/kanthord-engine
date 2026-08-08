import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScenarioContext } from "./scenario/context.ts";
import type { PodmanExecutor } from "./driver/podman.ts";

export type ResourceKind =
  | "directory"
  | "home"
  | "lock"
  | "process"
  | "container"
  | "pod"
  | "network"
  | "volume"
  | "secret"
  | "file"
  | "image";

export type Resource = Readonly<{
  kind: ResourceKind;
  id: string;
  release(): Promise<void>;
}>;

export type ResourceHandle = Readonly<{ kind: ResourceKind; id: string }>;

export type ResourceFailure = Readonly<{
  kind: ResourceKind;
  id: string;
  reason: string;
}>;

export type Ledger = Readonly<{
  take(resource: Resource): void;
  taken(): readonly ResourceHandle[];
}>;

export type LedgerResult<T> = Readonly<{
  value: T;
  failures: readonly ResourceFailure[];
}>;

export type WithCleanupFailures = Error & {
  cleanupFailures?: readonly ResourceFailure[];
};

export function createLedger(): Ledger & {
  releaseAll(): Promise<readonly ResourceFailure[]>;
} {
  let resources: Resource[] = [];

  return {
    take(resource: Resource): void {
      resources.push(resource);
    },
    taken(): readonly ResourceHandle[] {
      return resources.map(({ kind, id }) => ({ kind, id }));
    },
    async releaseAll(): Promise<readonly ResourceFailure[]> {
      const pending = resources;
      resources = [];

      const failures: ResourceFailure[] = [];
      for (const resource of [...pending].reverse()) {
        try {
          await resource.release();
        } catch (error) {
          failures.push({
            kind: resource.kind,
            id: resource.id,
            reason: String(error),
          });
        }
      }

      return failures;
    },
  };
}

function installSignalHandler(
  signal: NodeJS.Signals,
  ledger: { releaseAll(): Promise<readonly ResourceFailure[]> },
): () => void {
  const handler = (): void => {
    void (async () => {
      await ledger.releaseAll();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    })();
  };
  process.once(signal, handler);
  return handler;
}

export async function withLedger<T>(
  body: (ledger: Ledger) => Promise<T>,
): Promise<LedgerResult<T>> {
  const ledger = createLedger();
  const sigintHandler = installSignalHandler("SIGINT", ledger);
  const sigtermHandler = installSignalHandler("SIGTERM", ledger);

  let outcome:
    Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;
  let failures: readonly ResourceFailure[] = [];

  try {
    try {
      const value = await body(ledger);
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      failures = await ledger.releaseAll();
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
  }

  if (!outcome.ok) {
    if (failures.length > 0) {
      (outcome.error as WithCleanupFailures).cleanupFailures = failures;
    }
    throw outcome.error;
  }

  return { value: outcome.value, failures };
}

export async function takeTemporaryDirectory(
  context: Pick<ScenarioContext, "take">,
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  takeDirectory(context, directory);
  return directory;
}

export function takeDirectory(
  context: Pick<ScenarioContext, "take">,
  path: string,
): void {
  context.take({
    kind: "directory",
    id: path,
    async release(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  });
}

export function takeImage(
  context: Pick<ScenarioContext, "take">,
  execute: PodmanExecutor,
  id: string,
): void {
  context.take({
    kind: "image",
    id,
    async release(): Promise<void> {
      await execute(["podman", "image", "rm", "--force", id]);
    },
  });
}

export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
