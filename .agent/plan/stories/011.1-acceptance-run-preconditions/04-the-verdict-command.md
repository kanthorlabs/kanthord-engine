# Story 04 — The verdict command, on two axes

Epic: `.agent/plan/epics/011.1-acceptance-run-preconditions.md`
Depends on: Story 02 (`verify.json`) and Story 03 (`acceptance.json`).

## Change

### 1. New file `scripts/e2e/lib/record/verdict.ts`

```ts
export type Axis = "scenario" | "acceptance";

export type VerdictFailure = Readonly<{
  axis: Axis;
  code: RunnerErrorCode;
  reason: string;
}>;

export async function verdict(
  input: Readonly<{ tag: string; scenariosOnly: boolean }>,
): Promise<readonly VerdictFailure[]>;
```

`verdict` reads and returns. It opens files with `readFile` only. It creates no directory, writes no
file and never throws a `RunnerError` — a fault is a returned row.

The checks run in exactly this order, and every failure found is appended to the list:

1. **Bundles present.** For each id of `["P1-E1", "P1-E2", "P1-E3", "P1-E4"]` in that order, read
   `join(bundleDirectory(tag, id), "bundle.json")`. Absent → `{ scenario, unavailable,
`${id} has no bundle under tag ${tag}` }`.
2. **Verify record present.** Read `verifyRecordPath(tag)`. Absent → `{ scenario, unavailable,
`tag ${tag} has no verify record` }`.
3. **Verify passed.** Present and `exitCode !== 0` → `{ scenario, assertion-failed,
`the verify record reports exit status ${exitCode}` }`.
4. **Every bundle passed.** For each id in order, for each bundle that was read,
   `outcome !== "passed"` → `{ scenario, assertion-failed, `${id} reports ${outcome}` }`.
5. **One tag is one commit.** Only when the verify record was read. For each id in order, for each
   bundle that was read, `bundle.commit !== verify.commit` → `{ scenario, assertion-failed,
`${id} is on commit ${bundle.commit}; the verify record is on ${verify.commit}` }`.
6. **One proposal revision.** Only when both the verify record and the acceptance record were read
   and `acceptance.proposalRevision !== verify.proposalRevision` → `{ scenario, assertion-failed,
`the acceptance record names proposal revision ${a}; the verify record names ${b}` }`.
7. If `scenariosOnly` is `true`, return the list now. Steps 8 to 11 do not run.
8. **Acceptance record present.** Read `acceptanceRecordPath(tag)`. Absent → `{ acceptance,
unavailable, `tag ${tag} has no acceptance record` }`.
9. `drive !== "confirmed"` → `{ acceptance, assertion-failed, `the acceptance record reports drive
   ${drive}` }`.
10. `judgment !== "accepted"` → `{ acceptance, assertion-failed, `the acceptance record reports
    judgment ${judgment}` }`.
11. Only when the verify record was read: `acceptance.commit !== verify.commit` →
    `{ acceptance, assertion-failed, `the acceptance record is on commit ${a}; the verify record is
    on ${b}` }`.

The acceptance record is read once, before step 6, and reused by steps 8 to 11.

### 2. `scripts/e2e/lib/main.ts` — the options, the type and the branch

Option loop:

- `--verdict` joins the value-taking option list at `main.ts:68-73`, assigning `verdictTag`. Validate
  the value against `tagPattern` exactly as `--tag` does at `main.ts:82-89`, with the same message
  `tag ${value} is not a valid tag`.
- `--scenarios-only` joins the valueless-flag branch, setting `scenariosOnly = true`.

Type:

```ts
export type VerdictInvocation = Readonly<{
  verdictTag: string;
  scenariosOnly: boolean;
}>;
```

Widen `Invocation` with it.

Refusal block, placed immediately after the four `applies to --record-acceptance only` guards of
Story 03 and before the `reclaimTag` block:

```ts
if (verdictTag !== undefined) {
  if (positionals.length > 0) {
    throw new RunnerError(
      "invalid-argument",
      "--verdict is mutually exclusive with a scenario id",
    );
  }
  if (tag !== undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--verdict is mutually exclusive with --tag",
    );
  }
  if (reclaimTag !== undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--verdict is mutually exclusive with --reclaim",
    );
  }

  return { verdictTag, scenariosOnly };
}

if (scenariosOnly) {
  throw new RunnerError(
    "invalid-argument",
    "--scenarios-only applies to --verdict only",
  );
}
```

Add `--mint-tag is mutually exclusive with --verdict` and
`--record-verify is mutually exclusive with --verdict` and
`--record-acceptance is mutually exclusive with --verdict` to the three earlier blocks, following
the pattern Story 03 established.

Branch in `main`, after the `"recordAcceptance" in invocation` branch:

```ts
if ("verdictTag" in invocation) {
  const failures = await verdict({
    tag: invocation.verdictTag,
    scenariosOnly: invocation.scenariosOnly,
  });
  for (const failure of failures) {
    process.stderr.write(
      `e2e: verdict: ${failure.axis} axis: ${failure.reason}\n`,
    );
  }
  if (failures.length === 0) {
    return 0;
  }
  return exitCodeFor(failures[0].code);
}
```

The first failure decides the exit status, so the order of the checks above is the order of the exit
statuses. `exitCodeFor` (`main.ts:176-186`) already maps `unavailable` to `3` and `assertion-failed`
to `1`; an argument fault reaches `2` through the existing catch.

## Constraints

- `verdict` writes nothing. No `mkdir`, no `writeFile`, no `rm`.
- A missing artifact is `unavailable`; a present artifact reporting a failure is `assertion-failed`.
  Never the other way round.
- `--scenarios-only` stops after step 7. It must never read `acceptance.json`, so a rehearsal on a
  tag with no acceptance record exits `0`.
- Every reason string is asserted verbatim by a test. Do not reword one.

## Verify

New file `scripts/e2e/lib/record/verdict.test.ts`. Each case builds a run directory in its own temp
cwd with a small local helper that writes a bundle stub (`{ scenarioId, commit, outcome }` is enough
for `verdict`; write it through `serializeBundle` if a full bundle is simpler to fake), a verify
record and an acceptance record.

1. A complete run — four `passed` bundles on commit `c1`, a verify record with `exitCode: 0` on
   `c1`, an acceptance record with `drive: confirmed`, `judgment: accepted`, commit `c1` and the
   same proposal revision → `verdict` returns `[]` and `main(["--verdict", "t1"])` resolves `0`.
2. One failure per case, each asserting the returned row's `axis`, `code` and exact `reason`, and
   the exit status of `main(["--verdict", "t1"])`:
   - `P1-E4` bundle absent → `scenario`, `unavailable`, `P1-E4 has no bundle under tag t1`, exit `3`
   - `P1-E2` bundle `outcome: "failed"` → `scenario`, `assertion-failed`, `P1-E2 reports failed`,
     exit `1`
   - `P1-E2` bundle `outcome: "unavailable"` → `scenario`, `assertion-failed`,
     `P1-E2 reports unavailable`, exit `1`
   - `verify.json` absent → `scenario`, `unavailable`, `tag t1 has no verify record`, exit `3`
   - `verify.json` `exitCode: 1` → `scenario`, `assertion-failed`,
     `the verify record reports exit status 1`, exit `1`
   - `P1-E3` bundle on commit `c2` → `scenario`, `assertion-failed`,
     `P1-E3 is on commit c2; the verify record is on c1`, exit `1`
   - acceptance record on proposal revision `p2` → `scenario`, `assertion-failed`,
     `the acceptance record names proposal revision p2; the verify record names p1`, exit `1`
   - `acceptance.json` absent → `acceptance`, `unavailable`, `tag t1 has no acceptance record`,
     exit `3`
   - `drive: "not-confirmed"` → `acceptance`, `assertion-failed`,
     `the acceptance record reports drive not-confirmed`, exit `1`
   - `judgment: "rejected"` → `acceptance`, `assertion-failed`,
     `the acceptance record reports judgment rejected`, exit `1`
   - acceptance record on commit `c2` → `acceptance`, `assertion-failed`,
     `the acceptance record is on commit c2; the verify record is on c1`, exit `1`
3. `main(["--verdict", "t1"])` writes one stderr line per failure, in list order, each formatted
   `e2e: verdict: <axis> axis: <reason>`. Capture with `t.mock.method(process.stderr, "write", ...)`.
4. `--scenarios-only` — a complete scenario axis with **no** acceptance record returns `[]` and
   exits `0`; a missing `P1-E1` bundle with a valid acceptance record still returns the scenario
   failure and exits `3`.
5. **Read-only** — build a complete run directory, walk it recursively collecting
   `{ relativePath, sha256 }` for every file, run `main(["--verdict", "t1"])`, walk again and
   `assert.deepEqual` the two lists. Repeat for a failing run directory.
6. Refusals, exact messages:
   - `["--verdict", "t1", "P1-E1"]` → `--verdict is mutually exclusive with a scenario id`
   - `["--verdict", "t1", "--tag", "t2"]` → `--verdict is mutually exclusive with --tag`
   - `["--verdict", "t1", "--reclaim", "t2"]` → `--verdict is mutually exclusive with --reclaim`
   - `["--scenarios-only", "P1-E1"]` → `--scenarios-only applies to --verdict only`
   - `["--verdict", "not a tag"]` → `tag not a tag is not a valid tag`
7. `parseArguments(["--verdict", "t1", "--scenarios-only"], "x")` deep-equals
   `{ verdictTag: "t1", scenariosOnly: true }`.

- `npm run verify` exits 0.
- Proof: delivers the `--verdict "$TAG"` line of the EPIC Proof block. Under that Proof the tag holds
  `P1-E1` and `P1-E2` bundles and a passing verify record, so step 1 reports
  `P1-E3 has no bundle under tag <tag>` with code `unavailable` and the exit status is **`3`**.

  The EPIC Proof line reads `test $? -eq 3`. Do not change it to `1`.
