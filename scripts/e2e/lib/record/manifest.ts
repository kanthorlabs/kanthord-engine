import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RunnerError, type RunnerErrorCode } from "../errors.ts";
import { redact } from "../redact.ts";
import { runDirectory, type ScenarioId } from "../tag.ts";

export const manifestSchemaVersion = 1;

export const checklistAnswers = ["confirmed", "rejected"] as const;
export type ChecklistAnswer = (typeof checklistAnswers)[number];

export const manifestOutcomes = ["passed", "failed"] as const;
export type ManifestOutcome = (typeof manifestOutcomes)[number];

export const declaredScenarioOrder: readonly ScenarioId[] = [
  "P1-E1",
  "P1-E2",
  "P1B-E1",
  "P1-E4",
  "P1B-E2",
  "P1B-E3",
  "P1-E5",
];

export function manifestRecordPath(tag: string): string {
  return join(runDirectory(tag), "manifest.json");
}

export function digestOf(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export type ManifestScenario = Readonly<{
  id: ScenarioId;
  bundlePath: string;
  sha256: string;
  outcome: string;
}>;

export type ChecklistRow = Readonly<{
  row: number;
  subject: string;
  answer: ChecklistAnswer;
  note: string;
}>;

export type ManifestReport = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
}>;

export type ManifestFinding = Readonly<{
  id: string;
  action: "YES" | "NO";
  name: string;
  description: string;
  fixEpic: string | null;
}>;

export type Manifest = Readonly<{
  schemaVersion: number;
  tag: string;
  commit: string;
  proposalRevision: string;
  scenarios: readonly ManifestScenario[];
  checklist: readonly ChecklistRow[];
  report: ManifestReport;
  findings: readonly ManifestFinding[];
  outcome: ManifestOutcome;
}>;

export function serializeManifest(manifest: Manifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    tag: manifest.tag,
    commit: manifest.commit,
    proposalRevision: manifest.proposalRevision,
    scenarios: manifest.scenarios.map((scenario) => ({
      id: scenario.id,
      bundlePath: scenario.bundlePath,
      sha256: scenario.sha256,
      outcome: scenario.outcome,
    })),
    checklist: manifest.checklist.map((row) => ({
      row: row.row,
      subject: row.subject,
      answer: row.answer,
      note: row.note,
    })),
    report: {
      path: manifest.report.path,
      sha256: manifest.report.sha256,
      bytes: manifest.report.bytes,
    },
    findings: manifest.findings.map((finding) => ({
      id: finding.id,
      action: finding.action,
      name: finding.name,
      description: finding.description,
      fixEpic: finding.fixEpic,
    })),
    outcome: manifest.outcome,
  };

  return redact(`${JSON.stringify(ordered, null, 2)}\n`);
}

export type ManifestFailure = Readonly<{
  code: RunnerErrorCode;
  reason: string;
}>;

export type RecordManifestInput = Readonly<{
  tag: string;
  manifestFile: string;
}>;

export type RecordManifestDependencies = Readonly<{
  readCommit(): Promise<string>;
  readProposalRevision(): Promise<string>;
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifestShape(value: unknown): Manifest | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.schemaVersion !== "number") {
    return null;
  }
  if (
    typeof value.tag !== "string" ||
    typeof value.commit !== "string" ||
    typeof value.proposalRevision !== "string"
  ) {
    return null;
  }

  if (!Array.isArray(value.scenarios)) {
    return null;
  }
  const scenarios: ManifestScenario[] = [];
  for (const scenario of value.scenarios) {
    if (
      !isRecord(scenario) ||
      typeof scenario.id !== "string" ||
      typeof scenario.bundlePath !== "string" ||
      typeof scenario.sha256 !== "string" ||
      typeof scenario.outcome !== "string"
    ) {
      return null;
    }
    scenarios.push({
      id: scenario.id as ScenarioId,
      bundlePath: scenario.bundlePath,
      sha256: scenario.sha256,
      outcome: scenario.outcome,
    });
  }

  if (!Array.isArray(value.checklist)) {
    return null;
  }
  const checklist: ChecklistRow[] = [];
  for (const row of value.checklist) {
    if (
      !isRecord(row) ||
      typeof row.row !== "number" ||
      typeof row.subject !== "string" ||
      typeof row.answer !== "string" ||
      typeof row.note !== "string"
    ) {
      return null;
    }
    checklist.push({
      row: row.row,
      subject: row.subject,
      answer: row.answer as ChecklistAnswer,
      note: row.note,
    });
  }

  if (!isRecord(value.report)) {
    return null;
  }
  if (
    typeof value.report.path !== "string" ||
    typeof value.report.sha256 !== "string" ||
    typeof value.report.bytes !== "number"
  ) {
    return null;
  }
  const report: ManifestReport = {
    path: value.report.path,
    sha256: value.report.sha256,
    bytes: value.report.bytes,
  };

  if (!Array.isArray(value.findings)) {
    return null;
  }
  const findings: ManifestFinding[] = [];
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      typeof finding.id !== "string" ||
      typeof finding.action !== "string" ||
      typeof finding.name !== "string" ||
      typeof finding.description !== "string" ||
      (finding.fixEpic !== null && typeof finding.fixEpic !== "string")
    ) {
      return null;
    }
    findings.push({
      id: finding.id,
      action: finding.action as ManifestFinding["action"],
      name: finding.name,
      description: finding.description,
      fixEpic: finding.fixEpic,
    });
  }

  if (typeof value.outcome !== "string") {
    return null;
  }

  return {
    schemaVersion: value.schemaVersion,
    tag: value.tag,
    commit: value.commit,
    proposalRevision: value.proposalRevision,
    scenarios,
    checklist,
    report,
    findings,
    outcome: value.outcome as ManifestOutcome,
  };
}

function parseBundleShape(value: unknown): Readonly<{
  tag: string;
  scenarioId: string;
  commit: string;
  outcome: string;
}> | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.tag !== "string" ||
    typeof value.scenarioId !== "string" ||
    typeof value.commit !== "string" ||
    typeof value.outcome !== "string"
  ) {
    return null;
  }
  return {
    tag: value.tag,
    scenarioId: value.scenarioId,
    commit: value.commit,
    outcome: value.outcome,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function failure(code: RunnerErrorCode, reason: string): ManifestFailure {
  return { code, reason };
}

export async function recordManifest(
  dependencies: RecordManifestDependencies,
  input: RecordManifestInput,
): Promise<Manifest> {
  const recordPath = manifestRecordPath(input.tag);
  if (await exists(recordPath)) {
    throw new RunnerError(
      "tag-reused",
      `tag ${input.tag} already holds a manifest`,
    );
  }

  let sourceText: string;
  try {
    sourceText = await readFile(input.manifestFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunnerError(
        "invalid-argument",
        `--manifest ${input.manifestFile} does not exist`,
      );
    }
    throw error;
  }

  let sourceValue: unknown;
  try {
    sourceValue = JSON.parse(sourceText) as unknown;
  } catch {
    throw new RunnerError(
      "invalid-argument",
      `--manifest ${input.manifestFile} is not valid JSON`,
    );
  }

  const source = parseManifestShape(sourceValue);
  if (source === null) {
    throw new RunnerError(
      "invalid-argument",
      `--manifest ${input.manifestFile} is not a manifest`,
    );
  }

  const record: Manifest = {
    ...source,
    schemaVersion: manifestSchemaVersion,
    tag: input.tag,
    commit: await dependencies.readCommit(),
    proposalRevision: await dependencies.readProposalRevision(),
  };

  await mkdir(runDirectory(input.tag), { recursive: true });
  await writeFile(recordPath, serializeManifest(record), "utf8");

  return record;
}

async function readBytes(
  path: string,
): Promise<
  Readonly<{ kind: "missing" }> | Readonly<{ kind: "ok"; bytes: Buffer }>
> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { kind: "missing" };
  }
  return { kind: "ok", bytes };
}

export async function checkManifest(
  tag: string,
): Promise<readonly ManifestFailure[]> {
  const path = manifestRecordPath(tag);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [failure("unavailable", `tag ${tag} has no manifest`)];
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return [
      failure(
        "assertion-failed",
        `manifest.json at ${path} is not valid JSON: ${(error as Error).message}`,
      ),
    ];
  }

  const manifest = parseManifestShape(value);
  if (manifest === null) {
    return [
      failure("assertion-failed", `manifest.json at ${path} is not a manifest`),
    ];
  }

  const failures: ManifestFailure[] = [];

  if (manifest.tag !== tag) {
    failures.push(
      failure(
        "assertion-failed",
        `the manifest names tag ${manifest.tag}; the run tag is ${tag}`,
      ),
    );
  }
  if (manifest.schemaVersion !== manifestSchemaVersion) {
    failures.push(
      failure(
        "assertion-failed",
        `the manifest names schema version ${manifest.schemaVersion}; this runner writes ${manifestSchemaVersion}`,
      ),
    );
  }
  if (!(manifestOutcomes as readonly string[]).includes(manifest.outcome)) {
    failures.push(
      failure(
        "assertion-failed",
        `the manifest outcome ${manifest.outcome} is not passed or failed`,
      ),
    );
  }

  const scenarioLength = Math.max(
    manifest.scenarios.length,
    declaredScenarioOrder.length,
  );
  for (let index = 0; index < scenarioLength; index += 1) {
    const actual = manifest.scenarios[index]?.id;
    const expected = declaredScenarioOrder[index];
    if (actual === undefined && expected !== undefined) {
      failures.push(
        failure(
          "assertion-failed",
          `scenario position ${index} is absent; the declared order names ${expected}`,
        ),
      );
      break;
    }
    if (actual !== undefined && expected === undefined) {
      failures.push(
        failure(
          "assertion-failed",
          `scenario position ${index} is ${actual}; the declared order ends at position ${declaredScenarioOrder.length}`,
        ),
      );
      break;
    }
    if (actual !== expected) {
      failures.push(
        failure(
          "assertion-failed",
          `scenario position ${index} is ${actual}; the declared order names ${expected}`,
        ),
      );
      break;
    }
  }

  for (const entry of manifest.scenarios) {
    const result = await readBytes(entry.bundlePath);
    if (result.kind === "missing") {
      failures.push(
        failure("unavailable", `the bundle at ${entry.bundlePath} is absent`),
      );
      continue;
    }

    const actualDigest = digestOf(result.bytes);
    if (actualDigest !== entry.sha256) {
      failures.push(
        failure(
          "assertion-failed",
          `the bundle at ${entry.bundlePath} digests to ${actualDigest}; the manifest records ${entry.sha256}`,
        ),
      );
      continue;
    }

    let bundleValue: unknown;
    try {
      bundleValue = JSON.parse(result.bytes.toString("utf8")) as unknown;
    } catch {
      failures.push(
        failure(
          "assertion-failed",
          `the bundle at ${entry.bundlePath} is not a bundle`,
        ),
      );
      continue;
    }

    const bundle = parseBundleShape(bundleValue);
    if (bundle === null) {
      failures.push(
        failure(
          "assertion-failed",
          `the bundle at ${entry.bundlePath} is not a bundle`,
        ),
      );
      continue;
    }
    if (bundle.tag !== tag) {
      failures.push(
        failure(
          "assertion-failed",
          `the bundle at ${entry.bundlePath} names tag ${bundle.tag}; the run tag is ${tag}`,
        ),
      );
    }
    if (bundle.scenarioId !== entry.id) {
      failures.push(
        failure(
          "assertion-failed",
          `the bundle at ${entry.bundlePath} names scenario ${bundle.scenarioId}; the manifest names ${entry.id}`,
        ),
      );
    }
    if (bundle.outcome !== entry.outcome) {
      failures.push(
        failure(
          "assertion-failed",
          `the bundle at ${entry.bundlePath} reports ${bundle.outcome}; the manifest records ${entry.outcome}`,
        ),
      );
    }
    if (bundle.commit !== manifest.commit) {
      failures.push(
        failure(
          "assertion-failed",
          `the bundle at ${entry.bundlePath} is on commit ${bundle.commit}; the manifest names ${manifest.commit}`,
        ),
      );
    }
  }

  if (manifest.checklist.length !== 6) {
    failures.push(
      failure(
        "assertion-failed",
        `the checklist holds ${manifest.checklist.length} rows; six are required`,
      ),
    );
  }
  for (const row of manifest.checklist) {
    if (!(checklistAnswers as readonly string[]).includes(row.answer)) {
      failures.push(
        failure(
          "assertion-failed",
          `checklist row ${row.row} answers ${row.answer}; confirmed or rejected is required`,
        ),
      );
      continue;
    }
    if (row.answer === "rejected" && row.note.trim().length === 0) {
      failures.push(
        failure(
          "assertion-failed",
          `checklist row ${row.row} is rejected and carries no note`,
        ),
      );
    }
  }

  const reportResult = await readBytes(manifest.report.path);
  if (reportResult.kind === "missing") {
    failures.push(
      failure("unavailable", `the report at ${manifest.report.path} is absent`),
    );
  } else {
    const reportBytes = reportResult.bytes;
    if (reportBytes.length === 0) {
      failures.push(
        failure(
          "assertion-failed",
          `the report at ${manifest.report.path} is empty`,
        ),
      );
    }
    if (reportBytes.length !== manifest.report.bytes) {
      failures.push(
        failure(
          "assertion-failed",
          `the report at ${manifest.report.path} is ${reportBytes.length} bytes; the manifest records ${manifest.report.bytes}`,
        ),
      );
    }
    const actualDigest = digestOf(reportBytes);
    if (actualDigest !== manifest.report.sha256) {
      failures.push(
        failure(
          "assertion-failed",
          `the report at ${manifest.report.path} digests to ${actualDigest}; the manifest records ${manifest.report.sha256}`,
        ),
      );
    }
  }

  for (const finding of manifest.findings) {
    if (
      finding.id.startsWith("B") &&
      (finding.fixEpic === null || finding.fixEpic.trim().length === 0)
    ) {
      failures.push(
        failure(
          "assertion-failed",
          `finding ${finding.id} is a blocker and names no fix epic`,
        ),
      );
    }
  }

  if (manifest.outcome === "passed") {
    for (const scenario of manifest.scenarios) {
      if (scenario.outcome !== "passed") {
        failures.push(
          failure(
            "assertion-failed",
            `the manifest outcome is passed; scenario ${scenario.id} reports ${scenario.outcome}`,
          ),
        );
      }
    }
    for (const row of manifest.checklist) {
      if (row.answer === "rejected" && row.note.trim().length > 0) {
        failures.push(
          failure(
            "assertion-failed",
            `the manifest outcome is passed; checklist row ${row.row} is rejected`,
          ),
        );
      }
    }
  }

  return failures;
}
