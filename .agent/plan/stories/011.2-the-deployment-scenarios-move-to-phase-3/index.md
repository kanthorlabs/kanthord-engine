# EPIC 011.2 — The deployment scenarios move to phase 3 — stories

Epic: `.agent/plan/epics/011.2-the-deployment-scenarios-move-to-phase-3.md`
Prereq: EPIC 011.1 (sequence order). Its runner, verdict and records are in place and committed.

Phase 1 declares P1-E5: the P1-E1 journey against a real git forge, on one machine, mode
`integration`. P1-E3 leaves phase 1 and its oracle is P3-E6 in the proposal. No phase-1 scenario
crosses the VPN.

## Dispatch order

`00 → 01 → 02 → 03`

- **00 comes first and is a two-line widening.** Nothing declares `integration` until 01.
- **01 is atomic and cannot be split.** `scripts/e2e/lib/scenario/index.test.ts:32` asserts the
  `(mode, driver, profile)` triple per id and `:45` asserts exactly one `deployment` row, so a
  rename without the driver and mode change is red. `scripts/e2e/lib/main.ts:611` and `:617`
  compare `scenario.id !== "P1-E3"`, so dropping the union member without changing those guards
  fails `npm run typecheck`. The guard change is inside 01 for that reason.
- 02 and 03 are independent of one another and each depends on 01.

## Stories

- 00 — `integration` joins the `ScenarioDeclaration` and `Bundle` mode unions →
  `00-the-integration-mode.md`
- 01 — the id, the mode, the driver, the module, the host guards and every message become P1-E5 →
  `01-p1-e5-replaces-p1-e3.md`
- 02 — the remote ref advertisement is read before and after the run, through an injected reader →
  `02-the-forge-is-unchanged.md`
- 03 — the one remaining written reference is resolved, and the closed records are left alone →
  `03-the-documents-name-p1-e5.md`

## Facts (needed for implementation)

- **The id set is written out five times in production and twice in tests.** None derives from
  another: `scripts/e2e/lib/tag.ts:6` (the type union), `scripts/e2e/lib/main.ts:44-49`,
  `scripts/e2e/lib/record/verdict.ts:20-25`, `scripts/e2e/lib/record/acceptance.ts:63-68`,
  `scripts/e2e/lib/scenario/index.ts:20-49`, plus
  `scripts/e2e/lib/record/verdict.test.ts:26-31` and
  `scripts/e2e/lib/scenario/index.test.ts:9-16`. The four runtime arrays are typed
  `readonly ScenarioId[]`, so a **stale** `"P1-E3"` fails typecheck once the union changes, but a
  **missing** `"P1-E5"` does not. Edit all seven.
- **Byte order.** `"P1-E5" > "P1-E4"` (`0x35 > 0x34`).
  `scripts/e2e/lib/scenario/index.test.ts:22-30` asserts the ids are bytewise ascending, so the
  registry order becomes `P1-E1, P1-E2, P1-E4, P1-E5`.
- **A stale string comparison is a typecheck failure, not a silent bug.**
  `scripts/e2e/lib/main.ts:611` and `:617` hold `scenario.id !== "P1-E3"`. Once the union drops
  the member, TypeScript reports no overlap.
- **The two id lists mean different things.** `verdict.ts` requires **every** id to hold a bundle
  (`scripts/e2e/lib/record/verdict.ts:66-84`); `acceptance.ts` breaks on the **first** bundle it
  finds (`scripts/e2e/lib/record/acceptance.ts:84-91`). Both take the same four ids.
- **`createRealProfile` is already driver-agnostic.** `scripts/e2e/lib/profile/real.ts:5-34` calls
  only `driver.deliverDirectory("client", …)`, which the local driver implements at
  `scripts/e2e/lib/driver/local.ts:229-238`.
- **`checkPrerequisites` already reads `.env.e2e`.** `scripts/e2e/lib/scenario/p1-e3.ts:78-89`
  loads it through `loadE2eEnv` (`scripts/e2e/env.ts:50`) and translates `E2eEnvError` into
  `RunnerError("unavailable", …)`. `KANTHORD_E2E_REAL_ORIGIN`, `_BRANCH` and `_TOKEN_FILE` no
  longer exist. `KANTHORD_E2E_REAL_PLAN`, `_OBJECTIVES` and `_TASKS` remain and stay.
- **The trailing newline is safe.** `scripts/e2e/lib/driver/local.ts:254` writes the token as
  `` `${value}\n` `` while `scripts/e2e/lib/driver/ssh.ts:93` writes it raw.
  `src/cli/credential/register.ts:122` trims one trailing newline from a `--token-file`, so the
  local driver needs no change.
- **`ExecutionDriver` must not grow.** Three files build a complete literal of it —
  `scripts/e2e/lib/scenario/journey.test.ts:326`,
  `scripts/e2e/lib/scenario/startup-refusal.test.ts:46` and
  `scripts/e2e/lib/scenario/p1-e5.test.ts:370` (after the rename). A new required method breaks
  all three and forces two drivers to carry a refusal. Story 02 injects the reader instead.
- **A scenario may not import `src/`.** `docs/proposal/README.md:110`. `test/helpers/` is
  permitted: `scripts/e2e/lib/scenario/p1-e4.ts:4-5` and
  `scripts/e2e/lib/profile/fixture.ts:1-4` use it. `scripts/e2e/remote.ts` imports five
  `src/services/git/` modules and is therefore off-limits.
- **The shell-through-a-closure pattern.** `scripts/e2e/lib/driver/origin-probe.ts:19-64` builds a
  script string, takes a `runShell` closure, and reads a token from a file through a git
  credential helper. Story 02 copies it into `scripts/e2e/lib/remote-refs.ts`.
- **`scripts/e2e/007/` is a different registry.** Its `ScenarioId` union is `"E7-00a" … "E7-12"`
  (`scripts/e2e/007/index.ts:1-14`). The string `P1-E3` at `:106` is free text in a `goal` field.
- **`src/` holds no occurrence of `P1-E3`.** The rename does not reach the product.
- **A `forge-unchanged` failure is not automatically a product defect.** The two `ls-remote` reads
  bracket a real repository. A second writer between them fails the assertion with no product
  fault, so `E2E_GH_REPO` names a throwaway repository with no automation and no second writer.

## Planning notes

- `S1 - action:YES - EPIC bullets 1 and 3 are one story - a rename without the driver and mode change is red on index.test.ts, and dropping the ScenarioId member without changing the main.ts guards fails typecheck. Story 01 carries the rename, the driver swap and the guards.`
- `S2 - action:YES - EPIC bullet 2 is split across two stories - the mode union must widen before a row declares integration, and the exactly-one-integration assertion can only pass after that row exists. Story 00 widens; Story 01 asserts.`
- `S3 - action:NO - EPIC bullet 4 is largely already true - it says P1-E3 reads six KANTHORD_E2E_REAL_* variables; the code reads three and already loads .env.e2e through loadE2eEnv. The residue is the host-option refusal, now inside Story 01. No EPIC edit is needed to implement, but the bullet overstates the work.`
- `S4 - action:YES - EPIC bullet 5 does not name a mechanism - "the remote ref advertisement is identical before and after" is unreachable through any existing surface without importing src/. Story 02 adds one lib module and one injected dependency. The first draft added a sixteenth ExecutionDriver method; that was withdrawn because three test files build a complete driver literal.`
- `B1 - action:NO - the forge assertion detects, it does not guard - it runs after the journey, so a write the run makes and reverts passes. The EPIC states the assertion "makes a real-forge run safe to repeat", which over-claims. Story 02 records the limit. Amend the EPIC wording only if Ulrich wants the claim narrowed in the epic itself.`
