# Story 04 — P1-E1, the onboarding journey

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 01, Story 02, Story 03, Story 06.

Oracle: `docs/proposal/phase-1/README.md:61-78`. This story restates no rule of its own.

## Change

### New — `test/e2e/fixtures/two-objective/`

The **authored** input of the import. `docs/proposal/phase-1/plan-format.md:52` fixes that
an authored document may lack identities, reference by path and use noncanonical YAML, so
this fixture carries no ULID and its paths are its own.

```
test/e2e/fixtures/two-objective/README.md
test/e2e/fixtures/two-objective/plan/initiative.md
test/e2e/fixtures/two-objective/plan/alpha/objective.md
test/e2e/fixtures/two-objective/plan/alpha/01-first.md
test/e2e/fixtures/two-objective/plan/alpha/02-second.md
test/e2e/fixtures/two-objective/plan/beta/objective.md
test/e2e/fixtures/two-objective/plan/beta/01-first.md
test/e2e/fixtures/two-objective/plan/beta/02-second.md
```

One initiative, **two** objectives, **four** tasks — the counts
`docs/proposal/phase-1/README.md:76` fixes. One document per node, per
`plan-format.md:14-16`.

- No document carries an identity. Every `depends_on` is a relative file path, which
  `plan-format.md:29` permits before identities exist.
- Each objective names the repository by the registered name `fixture`.
- `README.md` states in three lines what the fixture is. It is not part of the plan and is
  excluded from the import by the `plan/` prefix.

**The authored fixture is never the byte-identity baseline.** `plan-format.md:52` and
`docs/proposal/api/graph.md:90` fix the baseline as the **accepted** documents the import
returned. `plan.import` returns them in the response body
(`docs/proposal/api/graph.md:56`), in the canonical layout, with minted ULIDs and rewritten
`depends_on`.

### New — `scripts/e2e/lib/scenario/journey.ts`

```ts
export type PlanDocument = Readonly<{ path: string; bytes: Buffer }>;

export type JourneyResult = Readonly<{
  credentialId: string;
  repositoryId: string;
  projectId: string;
  firstRevision: string;
  secondRevision: string;
  accepted: readonly PlanDocument[];
}>;

export async function runJourney(
  context: ScenarioContext,
  driver: ExecutionDriver,
  profile: ScenarioProfile,
): Promise<JourneyResult>;
```

Steps, in this exact order. The **assertion count is seventeen and the invocation count is
fifteen**: steps 1 and 2 inspect one daemon start, and steps 12 and 13 inspect one
re-import.

| #   | invocation                                                                                                    | assertion name                 |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | start the daemon with no config at any discovered location                                                    | `no-config-exit`               |
| 2   | — the same invocation                                                                                         | `no-config-names-search-order` |
| 3   | write the config at candidate 2 and start the daemon                                                          | `first-location-starts`        |
| 4   | `kanthord --version`, then `GET /v1/status`                                                                   | `version-parity`               |
| 5   | `kanthord credential register …` from `profile.credentialArguments`                                           | `credential-registered`        |
| 6   | `kanthord repository register --url <profile.origin> --credential fixture --upstream <profile.defaultBranch>` | `repository-registered`        |
| 7   | `kanthord repository show --id <repositoryId>`                                                                | `ref-layout`                   |
| 8   | `kanthord project create --name journey`                                                                      | `project-created`              |
| 9   | `kanthord project repository --project <id> --repository <id>`                                                | `repository-bound`             |
| 10  | `kanthord plan import --project <id> --path <profile.planDirectory> --from-revision ''`                       | `plan-imported`                |
| 11  | `kanthord plan export --project <id>`                                                                         | `export-byte-identical`        |
| 12  | `kanthord plan import --project <id> --path <accepted> --from-revision <firstRevision>`                       | `reimport-same-revision`       |
| 13  | — the same invocation                                                                                         | `reimport-choices-suggested`   |
| 14  | `kanthord plan import --project <id> --path <accepted> --from-revision <firstRevision>` again                 | `reimport-stale-revision`      |
| 15  | `kanthord status --project <id>`                                                                              | `status-counts`                |
| 16  | `kanthord run --project <id>`                                                                                 | `run-not-implemented`          |
| 17  | `kanthord status --project <id>` again                                                                        | `status-unchanged`             |

Pinned expectations:

1. exit code `1` — `src/main.ts:318` fixes exit `1` for `ConfigError`.
2. stderr equals
   `` `kanthord: config-not-found: no config file found; searched: ${candidates.join(", ")}\n` ``,
   the three candidates of `src/services/config/search-order.ts:18-24` in order, rendered
   against the journey's cwd and `HOME`. `KANTHORD_CONFIG` is unset, so candidate 1 is
   absent. The whole line is compared, so the search order is proved verbatim.
   **Precondition:** the driver asserts `/etc/kanthord/config.json` is absent on the daemon
   host before this step. Present, it throws
   `RunnerError("unavailable", "/etc/kanthord/config.json exists on the daemon host; P1-E1 needs a bare machine")`.
   The step never depends on unproven ambient state.
3. the daemon writes `kanthord: ready\n` to stdout — `src/main.ts:302` — within the
   readiness deadline of Story 09. The config is written at `<cwd>/kanthord.config.json`,
   candidate 2, and the process runs with that `cwd` and no `--config` flag.
4. `kanthord --version` stdout trimmed equals `system.status`'s `version` field, and equals
   `KANTHORD_VERSION` of `src/domain/version.ts:1`.
5. exit `0`, stdout matches `/^kanthord: registered (\S+) (\S+)$/m` —
   `src/cli/credential/register.ts:173`. `credentialId` is capture 2.
6. exit `0`, stdout carries `kanthord: registered <name> <id>` and
   `kanthord: upstream <profile.defaultBranch>`.
7. exit `0`, stdout carries **exactly one** line matching `/^kanthord: landing \S+ \S+$/`
   and **exactly one** matching `/^kanthord: tracking \S+ \S+$/`. This is the
   public-surface ref layout of `docs/proposal/phase-1/README.md:71`, and it is what P1-E3
   and P1-E4 assert too, because a client cannot read the daemon file system.
8. exit `0`, stdout matches `/^kanthord: registered journey (\S+)$/m`.
9. exit `0`.
10. exit `0`. `fromRevision` is the **empty** value: `src/http/contract/graph.ts:13,60`
    types `revision` as `z.string().nullable()`, so a project with no plan has revision
    `null` and the first import names `null`. There is no sentinel string. `firstRevision`
    is read from the response. `runJourney` writes the accepted documents of the response to
    `<workspace>/accepted/` and keeps them as `accepted`, per
    `docs/proposal/api/graph.md:56`: the client replaces its local plan directory with the
    accepted set.
11. `Buffer.compare` of each exported document's bytes against the **accepted** document at
    the same canonical path is `0`, and the two path lists deep-equal after sorting with
    `Buffer.compare`. `docs/proposal/api/graph.md:90` fixes that export at a revision equals
    the accepted documents of that revision's import, and explicitly not what the human
    submitted. Byte comparison, never string comparison.
12. exit `0`. `secondRevision` is read from the response.
13. every choice in the response is the suggested one —
    `choices.every((choice) => choice.selected === choice.suggested)` equals `true`.
14. exit code `150` — `stale-revision`, `src/cli/exit-code.ts:8-30` — and stderr matches
    `/^kanthord: stale-revision: /` and contains `secondRevision`, which is the current
    revision the daemon reports in `details`, per `docs/proposal/api/graph.md:64`.
15. exit `0`; the parsed status holds `profile.expectedObjectiveCount` objectives and
    `profile.expectedTaskCount` tasks, and every task state is `pending`.
16. exit code `220` — `not-implemented` — and stderr matches `/^kanthord: not-implemented:/`.
17. stdout of step 17 equals stdout of step 15, compared with `Buffer.compare`.

`runJourney` records `credentialId`, `repositoryId`, `projectId`, `firstRevision` and
`secondRevision` through `context.noteObject`, and attaches every accepted document as a
log, per `docs/proposal/phase-1/README.md:78`.

### New — `scripts/e2e/lib/scenario/p1-e1.ts`

```ts
export const p1e1: ScenarioDeclaration;
```

`{ id: "P1-E1", mode: "deterministic", driver: "local", profile: "fixture", run }`.

`run(context)`:

1. `createLocalDriver(context)`.
2. `createFixtureProfile(context, driver)` — the profile starts the fixture remote and
   delivers the plan directory. Story 06 owns both.
3. `runJourney(context, driver, profile)`.

It asserts nothing beyond `runJourney`.

## Constraints

- The journey drives the **installed** binary, never `src/main.ts` directly.
- Step 2 asserts the whole stderr line. A substring match would not prove the search order.
- Step 11 compares export against the accepted documents of step 10, never against
  `test/e2e/fixtures/two-objective/`. Comparing against the authored fixture is a defect,
  because an authored document has no identities to reproduce.
- No step reads the daemon home, opens SQLite, or imports from `src/`.
- The counts of step 15 come from the profile, so the real profile of Story 11 supplies its
  own. A literal `2` or `4` in `journey.ts` is a defect.

## Verify

`node --test scripts/e2e/lib/scenario/journey.test.ts`

Asserts, against a fake `ExecutionDriver` and a fake `ScenarioProfile` returning canned
`CommandRecord`s:

- `runJourney` issues exactly **fifteen** invocations, in the order of the table, asserted
  over the recorded argv list, and records exactly **seventeen** assertions, in table order,
  with the seventeen exact names.
- step 10's argv carries an empty `--from-revision`, and step 12's carries
  `firstRevision`.
- step 12 and step 14 issue identical argv, so the stale case differs only by what the
  daemon already committed.
- step 11 compares against the accepted documents: a fake whose export differs from the
  accepted set by one byte rejects naming `export-byte-identical`, while a fake whose
  export differs from the **authored fixture** but matches the accepted set passes.
- a fake whose step-2 stderr omits one of the three search-order paths rejects naming
  `no-config-names-search-order`.
- a fake whose step-16 exit code is `0` rejects naming `run-not-implemented`.
- a fake whose step-17 stdout differs from step 15 only in trailing whitespace rejects
  naming `status-unchanged`.
- a profile with `expectedObjectiveCount: 3` makes a two-objective status reject naming
  `status-counts`, proving the counts come from the profile.
- a driver reporting `/etc/kanthord/config.json` present makes `runJourney` reject with
  `RunnerError` code `unavailable` before any invocation.

`node --test scripts/e2e/lib/fixtures.test.ts`

This test lives under `scripts/`, not `test/e2e/`, because `eslint.config.js:25` applies
`boundaries/no-unknown-files` to `test/**/*.ts` and `test/e2e/` is not a declared element.
`test/e2e/fixtures/` therefore holds Markdown only. The test imports the plan parser from
`src/domain/plan-document.ts`, which `scripts/**` may do —
`scripts/e2e/007/run.ts:12-18` is the precedent.

Asserts:

- the fixture directory holds exactly the eight named files.
- parsing `plan/**` yields one initiative, two objectives, four tasks.
- no document contains a string matching `/\b[0-9A-HJKMNP-TV-Z]{26}\b/`, so no ULID is
  baked in and the fixture is a legal authored input under `plan-format.md:29`.
- every `depends_on` entry is a relative path, not an identity.
- `README.md` is outside `plan/` and is not part of the parsed set.

`npm run verify` exits 0.

Proof: `node scripts/e2e/run.mjs P1-E1`, the first line of the EPIC Proof block.
