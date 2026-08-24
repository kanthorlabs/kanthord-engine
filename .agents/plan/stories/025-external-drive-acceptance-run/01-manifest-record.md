# Story 1 — The manifest record and its canonical serialization

Epic: `.agents/plan/epics/025-external-drive-acceptance-run.md`
Depends on: EPIC 020, for the three `P1B-*` members of `ScenarioId` at `scripts/e2e/lib/tag.ts:6`.

This is the first half of the EPIC bullet at `025-external-drive-acceptance-run.md:125`. This story lands the record type, the declared order, the path helper and the serializer. Story 2 lands the checker and the runner option pair. **Stories 1 and 2 are a coupled pair and take no verify gate between them.**

## Change

Create `scripts/e2e/lib/record/manifest.ts` with exactly these imports:

```ts
import { createHash } from "node:crypto";
import { join } from "node:path";

import { redact } from "../redact.ts";
import { runDirectory, type ScenarioId } from "../tag.ts";
```

**The path helper lives in this file and not in `tag.ts`.** `025-external-drive-acceptance-run.md:241` fixes the file list of this epic, and `tag.ts` is not in it.

Export, in this order:

```ts
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
```

`declaredScenarioOrder` is the single statement of the run order of `025-external-drive-acceptance-run.md:131`. No other file restates it.

The record types:

```ts
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
```

`sha256` on `ManifestScenario` and on `ManifestReport` is **bare lowercase hex, 64 characters, with no `sha256:` prefix**, which is the form `HashRecord` takes at `scripts/e2e/lib/bundle.ts:299-301`.

### The serializer reconstructs every nested object

`serializeAcceptanceRecord` at `scripts/e2e/lib/record/acceptance.ts:47-61` orders a **flat** record, so ordering the root alone was enough there. This record nests, and `JSON.stringify` emits nested keys in construction order. **A root-only literal is not canonical**: two manifests equal member for member but built with different nested key order would serialize to different bytes and therefore to different digests. Rebuild every nested object explicitly:

```ts
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
```

Two-space indent, one trailing newline, the whole text through `redact`. `redact` at `scripts/e2e/lib/redact.ts:48-52` is a module-level singleton over strings; it is not injected and this file adds no injection point.

Array **element order** is the caller's, and the serializer does not sort. Element **key** order is the serializer's, and it is fixed above.

## Constraints

- Edit no file under `src/` and no file under `docs/proposal/`.
- Edit `scripts/e2e/lib/tag.ts` not at all. Every path derives from `runDirectory(tag)`.
- Add no member to `RunnerErrorCode` at `scripts/e2e/lib/errors.ts:1-2`.
- Do not sort `scenarios`, `checklist` or `findings`. Story 2 asserts their order instead.
- Do not add a `describe` block. Every test file under `scripts/e2e/lib/record/` uses flat `test(...)`.

## Verify

Create `scripts/e2e/lib/record/manifest.test.ts`. It imports `test` from `node:test` and `assert` from `node:assert/strict`, matching `scripts/e2e/lib/record/acceptance.test.ts:1-2`.

**The byte-exact fixture is pinned by these literal values.** Build `sampleManifest` in the test file from exactly this data, so the expected serialization is determined and the implementer chooses nothing:

```ts
const sampleManifest = {
  schemaVersion: 1,
  tag: "20260814120000000-01abcdefghijklmnopqrstuvwx",
  commit: "1111111111111111111111111111111111111111",
  proposalRevision: "2222222222222222222222222222222222222222",
  scenarios: [
    {
      id: "P1-E1",
      bundlePath: ".data/acceptance-t/P1-E1/bundle.json",
      sha256: "a".repeat(64),
      outcome: "passed",
    },
    {
      id: "P1-E2",
      bundlePath: ".data/acceptance-t/P1-E2/bundle.json",
      sha256: "b".repeat(64),
      outcome: "passed",
    },
  ],
  checklist: [
    {
      row: 1,
      subject: "the graph reads as the plan",
      answer: "confirmed",
      note: "",
    },
    {
      row: 2,
      subject: "the work is attributed",
      answer: "confirmed",
      note: "",
    },
    {
      row: 3,
      subject: "the result is readable from the node",
      answer: "confirmed",
      note: "",
    },
    {
      row: 4,
      subject: "the refusal is legible",
      answer: "confirmed",
      note: "",
    },
    {
      row: 5,
      subject: "the close is a human act",
      answer: "confirmed",
      note: "",
    },
    {
      row: 6,
      subject: "the block broke nothing he uses",
      answer: "confirmed",
      note: "",
    },
  ],
  report: {
    path: ".agents/acceptance/t/report.md",
    sha256: "c".repeat(64),
    bytes: 1234,
  },
  findings: [],
  outcome: "passed",
} as const;
```

- `node --test scripts/e2e/lib/record/manifest.test.ts` exits 0.
- Cases, each named as a full sentence:
  - `serializeManifest(sampleManifest)` equals one inline expected string, asserted with `assert.equal` over the whole text. Write the expected string as a template literal in the test file, with the nine root keys in the declared order and each nested object in the key order the serializer fixes. This is the byte-exact fixture `025-external-drive-acceptance-run.md:229` requires.
  - **the nested key order is the serializer's and not the input's** — build a second manifest whose `report` object literal is written `{ bytes, sha256, path }` and whose scenario literals are written `{ outcome, sha256, bundlePath, id }`, otherwise equal to `sampleManifest`, and assert its serialization is byte-identical to the first. This is the case a root-only literal fails.
  - the serialized text ends with exactly one `\n`, asserted with `assert.equal(text.at(-1), "\n")` and `assert.equal(text.at(-2), "}")`.
  - `serializeManifest` redacts a secret, asserted with the value `token-aaaaaaaa` placed in a finding `description` and `token-bbbbbbbb` placed in a checklist `note`. Hold each through `secrets.hold` from `../redact.ts` inside the test; each is fourteen characters, above the eight-character floor at `scripts/e2e/lib/redact.ts:24-32`. Assert the output holds `[redacted]` twice and holds neither token.
  - `declaredScenarioOrder` deep-equals the inline literal `["P1-E1","P1-E2","P1B-E1","P1-E4","P1B-E2","P1B-E3","P1-E5"]`.
  - `manifestRecordPath("t1")` equals `.data/acceptance-t1/manifest.json`, asserted by exact string.
  - `digestOf(Buffer.from("manifest"))` returns a 64-character lowercase hex string. Assert the length, assert `/^[0-9a-f]{64}$/`, and assert it equals `createHash("sha256").update(Buffer.from("manifest")).digest("hex")` computed in the test, so the story pins no digest literal by hand.
- `npx tsc --noEmit` exits 0. **Do not gate this story on `npm run verify`** — Story 2 adds the runner options that make the pair complete, and `index.md` places the verify gate at the close of Story 2.
- Proof: `PASS EPIC-025-UNIT`, the `node --test scripts/e2e/lib/record/manifest.test.ts` line of `025-external-drive-acceptance-run.md:192-194`. Story 2 completes the same Proof line.
