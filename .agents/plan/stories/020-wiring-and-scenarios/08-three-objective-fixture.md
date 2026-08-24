# Story 8 — The three-objective fixture and the plan axis

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 1.

## Change

### A new `test/e2e/fixtures/three-objective/`

Nine files. `README.md` sits outside `plan/`, so the import excludes it.

```text
README.md
plan/journey/initiative.md
plan/journey/alpha/objective.md
plan/journey/alpha/01-first.md
plan/journey/alpha/02-second.md
plan/journey/beta/objective.md
plan/journey/beta/01-first.md
plan/journey/beta/02-second.md
plan/journey/gamma/objective.md
plan/journey/gamma/01-first.md
```

Three objectives and five tasks. Mirror the frontmatter of `test/e2e/fixtures/two-objective` exactly: a task carries `kind`, `title`, `depends_on` when it has one, and `worker: general@1`; an objective carries `kind`, `title` and `repo: fixture`; the initiative carries `kind` and `title`. Every task body holds an `## Acceptance criteria` heading.

- The second task of `alpha` and of `beta` each declare `depends_on` on `./01-first.md`, exactly as `test/e2e/fixtures/two-objective/plan/journey/alpha/02-second.md` does.
- **`gamma/objective.md` declares `depends_on` on `../alpha/objective.md` and on `../beta/objective.md`**, which `docs/proposal/phase-1/plan-format.md:33` admits as a relative path between siblings.
- `gamma/01-first.md` declares no `depends_on`.
- No document holds an identity, and no document holds a string matching a ULID.

### `scripts/e2e/lib/fixtures.test.ts`

The file pins one fixture root today. Parametrise it over both roots. Declare one closed table:

```ts
const fixtures = [
  {
    root: "test/e2e/fixtures/two-objective",
    files: [...eight paths...],
    counts: { initiative: 1, objective: 2, task: 4 },
  },
  {
    root: "test/e2e/fixtures/three-objective",
    files: [...ten paths...],
    counts: { initiative: 1, objective: 3, task: 5 },
  },
];
```

Run each of the five existing cases over each row, naming the root in the test name. Add one case for the new fixture: `it("gamma declares depends_on on both sibling objectives", ...)`, asserting the two relative paths exactly, in the order the document holds them.

### The plan axis

- `scripts/e2e/lib/scenario/index.ts`: `ScenarioDeclaration` at `:12-18` gains a required field:

  ```ts
  plan: "two-objective" | "three-objective";
  ```

  Export the union as a named type from the same file. The four phase-1 declarations each take `"two-objective"`.

- `scripts/e2e/lib/profile/fixture.ts`: replace the three module constants at `:13-15` with one closed table keyed by the axis, holding the plan source, `expectedObjectiveCount` and `expectedTaskCount`:

  ```text
  two-objective   -> test/e2e/fixtures/two-objective/plan   2 objectives  4 tasks
  three-objective -> test/e2e/fixtures/three-objective/plan 3 objectives  5 tasks
  ```

  Export the table and the plan-source lookup, so `p1-e4.ts` reads the same source. `fixtureRootPath` follows the axis as well.

  `createFixtureProfile` at `:86` takes the axis as a third parameter and returns `planDirectory`, `expectedObjectiveCount`, `expectedTaskCount` and `fixtureRoot` from that table.

- `scripts/e2e/lib/scenario/p1-e4.ts`: `resolveFixturePlanDirectory` reads the plan source from the exported table rather than from the module constant. Pass the axis through from the declaration.

- Every existing caller of `createFixtureProfile` passes `"two-objective"`.

**`ScenarioProfile` gains no field.** The axis lives on `ScenarioDeclaration` only.

### The repository binding does not move

The fixture holds the plan only. The git remote, the seeded object ids and `expectedObjectIds` stay `fixtureObjectIds` from `test/helpers/remote/seed.ts`, because a repository binding is independent of a plan directory. Both axis values bind the same fixture repository.

## Constraints

- Edit no file under `test/e2e/fixtures/two-objective`.
- Add no fourth axis value and no `real` axis entry. `createRealProfile` is untouched and keeps `fixtureRoot: null`.
- The new fixture holds no identity, no ULID and no absolute path.

## Verify

- `node --test scripts/e2e/lib/fixtures.test.ts scripts/e2e/lib/profile/profile.test.ts scripts/e2e/lib/scenario/index.test.ts` exits 0.
- `scripts/e2e/lib/profile/profile.test.ts` gains one case per axis value asserting the returned `expectedObjectiveCount` and `expectedTaskCount`, and one case asserting `expectedObjectIds` deep-equals `fixtureObjectIds` for both.
- Importing the new fixture yields three objectives and five tasks, and `gamma` resolves `depends_on` to the two objective identities. Story 14 asserts that end to end.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/fixtures.test.ts`, `scripts/e2e/lib/profile/profile.test.ts`, `scripts/e2e/lib/scenario/index.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:167`.
