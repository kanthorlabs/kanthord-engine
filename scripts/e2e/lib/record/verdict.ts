import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunnerErrorCode } from "../errors.ts";
import {
  acceptanceRecordPath,
  bundleDirectory,
  verifyRecordPath,
  type ScenarioId,
} from "../tag.ts";

export type Axis = "scenario" | "acceptance";

export type VerdictFailure = Readonly<{
  axis: Axis;
  code: RunnerErrorCode;
  reason: string;
}>;

const knownScenarioIds: readonly ScenarioId[] = [
  "P1-E1",
  "P1-E2",
  "P1-E4",
  "P1-E5",
];

type RawBundle = Readonly<{ commit: string; outcome: string }>;
type RawVerify = Readonly<{
  exitCode: number;
  commit: string;
  proposalRevision: string;
}>;
type RawAcceptance = Readonly<{
  drive: string;
  judgment: string;
  commit: string;
  proposalRevision: string;
}>;

type RecordReadResult<T> =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "parse-fault"; message: string }>
  | Readonly<{ kind: "ok"; value: T }>;

async function readRecordJson<T>(path: string): Promise<RecordReadResult<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as T };
  } catch (error) {
    return { kind: "parse-fault", message: (error as Error).message };
  }
}

export async function verdict(
  input: Readonly<{ tag: string; scenariosOnly: boolean }>,
): Promise<readonly VerdictFailure[]> {
  const { tag, scenariosOnly } = input;
  const failures: VerdictFailure[] = [];

  const bundles = new Map<ScenarioId, RawBundle>();
  for (const scenarioId of knownScenarioIds) {
    const bundlePath = join(bundleDirectory(tag, scenarioId), "bundle.json");
    const bundleResult = await readRecordJson<RawBundle>(bundlePath);
    if (bundleResult.kind === "missing") {
      failures.push({
        axis: "scenario",
        code: "unavailable",
        reason: `${scenarioId} has no bundle under tag ${tag}`,
      });
    } else if (bundleResult.kind === "parse-fault") {
      failures.push({
        axis: "scenario",
        code: "assertion-failed",
        reason: `bundle.json at ${bundlePath} is not valid JSON: ${bundleResult.message}`,
      });
    } else {
      bundles.set(scenarioId, bundleResult.value);
    }
  }

  const verifyResult = await readRecordJson<RawVerify>(verifyRecordPath(tag));
  let verifyRecord: RawVerify | undefined;
  if (verifyResult.kind === "missing") {
    failures.push({
      axis: "scenario",
      code: "unavailable",
      reason: `tag ${tag} has no verify record`,
    });
  } else if (verifyResult.kind === "parse-fault") {
    failures.push({
      axis: "scenario",
      code: "assertion-failed",
      reason: `verify.json at ${verifyRecordPath(tag)} is not valid JSON: ${verifyResult.message}`,
    });
  } else {
    verifyRecord = verifyResult.value;
    if (verifyRecord.exitCode !== 0) {
      failures.push({
        axis: "scenario",
        code: "assertion-failed",
        reason: `the verify record reports exit status ${verifyRecord.exitCode}`,
      });
    }
  }

  for (const scenarioId of knownScenarioIds) {
    const bundle = bundles.get(scenarioId);
    if (bundle !== undefined && bundle.outcome !== "passed") {
      failures.push({
        axis: "scenario",
        code: "assertion-failed",
        reason: `${scenarioId} reports ${bundle.outcome}`,
      });
    }
  }

  if (verifyRecord !== undefined) {
    for (const scenarioId of knownScenarioIds) {
      const bundle = bundles.get(scenarioId);
      if (bundle !== undefined && bundle.commit !== verifyRecord.commit) {
        failures.push({
          axis: "scenario",
          code: "assertion-failed",
          reason: `${scenarioId} is on commit ${bundle.commit}; the verify record is on ${verifyRecord.commit}`,
        });
      }
    }
  }

  const acceptanceResult = await readRecordJson<RawAcceptance>(
    acceptanceRecordPath(tag),
  );
  const acceptanceRecord =
    acceptanceResult.kind === "ok" ? acceptanceResult.value : undefined;

  if (
    verifyRecord !== undefined &&
    acceptanceRecord !== undefined &&
    acceptanceRecord.proposalRevision !== verifyRecord.proposalRevision
  ) {
    failures.push({
      axis: "scenario",
      code: "assertion-failed",
      reason: `the acceptance record names proposal revision ${acceptanceRecord.proposalRevision}; the verify record names ${verifyRecord.proposalRevision}`,
    });
  }

  if (scenariosOnly) {
    return failures;
  }

  if (acceptanceResult.kind === "missing") {
    failures.push({
      axis: "acceptance",
      code: "unavailable",
      reason: `tag ${tag} has no acceptance record`,
    });
    return failures;
  }

  if (acceptanceResult.kind === "parse-fault") {
    failures.push({
      axis: "acceptance",
      code: "assertion-failed",
      reason: `acceptance.json at ${acceptanceRecordPath(tag)} is not valid JSON: ${acceptanceResult.message}`,
    });
    return failures;
  }

  const confirmedAcceptanceRecord = acceptanceResult.value;

  if (confirmedAcceptanceRecord.drive !== "confirmed") {
    failures.push({
      axis: "acceptance",
      code: "assertion-failed",
      reason: `the acceptance record reports drive ${confirmedAcceptanceRecord.drive}`,
    });
  }

  if (confirmedAcceptanceRecord.judgment !== "accepted") {
    failures.push({
      axis: "acceptance",
      code: "assertion-failed",
      reason: `the acceptance record reports judgment ${confirmedAcceptanceRecord.judgment}`,
    });
  }

  if (
    verifyRecord !== undefined &&
    confirmedAcceptanceRecord.commit !== verifyRecord.commit
  ) {
    failures.push({
      axis: "acceptance",
      code: "assertion-failed",
      reason: `the acceptance record is on commit ${confirmedAcceptanceRecord.commit}; the verify record is on ${verifyRecord.commit}`,
    });
  }

  return failures;
}
