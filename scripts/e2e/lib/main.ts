import { hostname, platform, arch } from "node:os";
import { ulid } from "ulid";

import { RunnerError, type RunnerErrorCode } from "./errors.ts";
import { claimBundleDirectory, mintTag, type ScenarioId } from "./tag.ts";
import {
  withLedger,
  type ResourceFailure,
  type WithCleanupFailures,
} from "./resources.ts";
import {
  createBundleWriter,
  readCommit,
  writeBundle,
  type Bundle,
} from "./bundle.ts";
import { scenarios } from "./scenario/index.ts";
import type { ScenarioContext } from "./scenario/context.ts";
import { assertPodman } from "./podman/preflight.ts";
import {
  reclaimByLabel,
  type ReclaimFailureDetail,
  type ReclaimReport,
} from "./podman/reclaim.ts";
import { runCommand, type CommandSink } from "./command.ts";
import { redact } from "./redact.ts";
import type { PodmanExecutor } from "./driver/podman.ts";

const knownScenarioIds: readonly ScenarioId[] = [
  "P1-E1",
  "P1-E2",
  "P1-E3",
  "P1-E4",
];

function isKnownScenarioId(value: string): value is ScenarioId {
  return (knownScenarioIds as readonly string[]).includes(value);
}

const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RunInvocation = Readonly<{
  scenarioId: ScenarioId;
  tag: string;
  daemonHost: string | null;
  clientHost: string | null;
}>;

export type ReclaimInvocation = Readonly<{ reclaimTag: string }>;

export type Invocation = RunInvocation | ReclaimInvocation;

export function parseArguments(
  argv: readonly string[],
  mintedTag: string,
): Invocation {
  const positionals: string[] = [];
  let tag: string | undefined;
  let daemonHost: string | null = null;
  let clientHost: string | null = null;
  let reclaimTag: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;

    if (token.startsWith("--")) {
      if (
        token !== "--tag" &&
        token !== "--daemon-host" &&
        token !== "--client-host" &&
        token !== "--reclaim"
      ) {
        throw new RunnerError("invalid-argument", `unknown option ${token}`);
      }

      const value = argv[index + 1];
      if (value === undefined) {
        throw new RunnerError("invalid-argument", `${token} needs a value`);
      }

      if (token === "--tag") {
        if (!tagPattern.test(value)) {
          throw new RunnerError(
            "invalid-argument",
            `tag ${value} is not a valid tag`,
          );
        }
        tag = value;
      } else if (token === "--daemon-host") {
        daemonHost = value;
      } else if (token === "--client-host") {
        clientHost = value;
      } else {
        reclaimTag = value;
      }

      index += 2;
    } else {
      positionals.push(token);
      index += 1;
    }
  }

  if (reclaimTag !== undefined) {
    if (positionals.length > 0) {
      throw new RunnerError(
        "invalid-argument",
        "--reclaim is mutually exclusive with a scenario id",
      );
    }
    if (tag !== undefined) {
      throw new RunnerError(
        "invalid-argument",
        "--reclaim is mutually exclusive with --tag",
      );
    }

    return { reclaimTag };
  }

  if (positionals.length === 0) {
    throw new RunnerError("invalid-argument", "no scenario id");
  }
  if (positionals.length > 1) {
    throw new RunnerError("invalid-argument", "more than one scenario id");
  }

  const [scenarioIdCandidate] = positionals as [string];
  if (!isKnownScenarioId(scenarioIdCandidate)) {
    throw new RunnerError(
      "invalid-argument",
      `unknown scenario ${scenarioIdCandidate}`,
    );
  }

  return {
    scenarioId: scenarioIdCandidate,
    tag: tag ?? mintedTag,
    daemonHost,
    clientHost,
  };
}

export function deriveOutcome(
  input: Readonly<{
    runError: unknown;
    cleanupFailures: readonly ResourceFailure[];
  }>,
): Bundle["outcome"] {
  if (
    input.runError instanceof RunnerError &&
    input.runError.code === "unavailable"
  ) {
    return "unavailable";
  }
  if (input.runError === undefined && input.cleanupFailures.length === 0) {
    return "passed";
  }
  return "failed";
}

export async function resolveCommit(
  read: () => Promise<string>,
): Promise<string> {
  try {
    return await read();
  } catch (error) {
    throw new RunnerError(
      "unavailable",
      `failed to read the commit under test: ${(error as Error).message}`,
    );
  }
}

function exitCodeFor(code: RunnerErrorCode): number {
  switch (code) {
    case "assertion-failed":
      return 1;
    case "invalid-argument":
    case "tag-reused":
      return 2;
    case "unavailable":
      return 3;
  }
}

function createDefaultExecute(): PodmanExecutor {
  const sink: CommandSink = { print: () => undefined, record: () => undefined };
  return async (argv, stdin, cwd) =>
    runCommand(sink, {
      argv: [...argv],
      stdin,
      cwd,
      env: { PATH: process.env.PATH ?? "" },
    });
}

function printReclaimReport(
  report: ReclaimReport,
  failureDetailsByKind: ReadonlyMap<string, ReclaimFailureDetail>,
): void {
  for (const outcome of report.reclaimed) {
    process.stdout.write(`e2e: reclaimed ${outcome.kind} ${outcome.id}\n`);
  }
  for (const outcome of report.failed) {
    const detail = failureDetailsByKind.get(outcome.kind);
    const reason =
      detail === undefined
        ? ""
        : ` (exit ${detail.exitCode ?? "n/a"}${detail.stderr.length > 0 ? `: ${redact(detail.stderr.trim())}` : ""})`;
    process.stderr.write(
      `e2e: failed to reclaim ${outcome.kind} ${outcome.id}${reason}\n`,
    );
  }
}

export async function main(
  argv: readonly string[],
  dependencies?: Readonly<{ execute?: PodmanExecutor }>,
): Promise<number> {
  try {
    const invocation = parseArguments(argv, mintTag(new Date(), ulid));

    if ("reclaimTag" in invocation) {
      const execute = dependencies?.execute ?? createDefaultExecute();
      await assertPodman(execute);
      const failureDetailsByKind = new Map<string, ReclaimFailureDetail>();
      const report = await reclaimByLabel(
        execute,
        invocation.reclaimTag,
        (kind, detail) => {
          failureDetailsByKind.set(kind, detail);
        },
      );
      printReclaimReport(report, failureDetailsByKind);
      return report.failed.length > 0 ? 1 : 0;
    }

    const scenario = scenarios.find(
      (entry) => entry.id === invocation.scenarioId,
    );
    if (scenario === undefined) {
      throw new RunnerError(
        "invalid-argument",
        `unknown scenario ${invocation.scenarioId}`,
      );
    }

    if (invocation.daemonHost !== null && scenario.id !== "P1-E3") {
      throw new RunnerError(
        "invalid-argument",
        "--daemon-host applies to P1-E3 only",
      );
    }
    if (invocation.clientHost !== null && scenario.id !== "P1-E3") {
      throw new RunnerError(
        "invalid-argument",
        "--client-host applies to P1-E3 only",
      );
    }

    const bundleDirectory = await claimBundleDirectory(
      invocation.tag,
      invocation.scenarioId,
    );

    const commit = await resolveCommit(() =>
      readCommit({ print: () => undefined, record: () => undefined }, "git"),
    );

    const writer = createBundleWriter({
      scenarioId: scenario.id,
      mode: scenario.mode,
      driver: scenario.driver,
      profile: scenario.profile,
      tag: invocation.tag,
      commit,
      startedAt: new Date().toISOString(),
      identity: {
        hostname: hostname(),
        platform: platform(),
        architecture: arch(),
      },
      fixtureHashes: [],
    });

    let runError: unknown;
    let cleanupFailures: readonly ResourceFailure[] = [];

    try {
      const result = await withLedger(async (ledger) => {
        const context = {
          tag: invocation.tag,
          scenarioId: invocation.scenarioId,
          bundleDirectory,
          take: ledger.take,
          daemonHost: invocation.daemonHost,
          clientHost: invocation.clientHost,
          ...writer,
        } as ScenarioContext;

        await scenario.run(context);
      });
      cleanupFailures = result.failures;
    } catch (error) {
      runError = error;
      cleanupFailures = (error as WithCleanupFailures).cleanupFailures ?? [];
    }

    const outcome = deriveOutcome({ runError, cleanupFailures });

    const bundle = writer.finish({
      outcome,
      cleanupFailures,
      finishedAt: new Date().toISOString(),
    });
    await writeBundle(bundleDirectory, bundle);

    if (runError !== undefined) {
      if (runError instanceof RunnerError) {
        process.stderr.write(`e2e: ${runError.code}: ${runError.message}\n`);
        return exitCodeFor(runError.code);
      }

      process.stderr.write(`e2e: ${(runError as Error).message}\n`);
      return 4;
    }

    return cleanupFailures.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof RunnerError) {
      process.stderr.write(`e2e: ${error.code}: ${error.message}\n`);
      return exitCodeFor(error.code);
    }

    process.stderr.write(`e2e: ${(error as Error).message}\n`);
    return 4;
  }
}
