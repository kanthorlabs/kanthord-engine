# Story 1 — Command admits `force` and suppresses the `default-chain` blocker

Epic: `.agents/plan/epics/042-forced-removal-of-a-default-holding-provider.md`

## Change

**`src/commands/provider/remove-provider.ts`**

- Extend `RemoveProviderInput` at lines 10-13. Add `force: boolean` as a required field:

  ```ts
  export type RemoveProviderInput = Readonly<{
    id: string;
    actor: string;
    force: boolean;
  }>;
  ```

- Guard the `default-chain` push at lines 68-70 with `!input.force`:
  ```ts
  if (target.set_default_at !== null && !input.force) {
    blockers.push({ kind: "default-chain" });
  }
  ```
  Lines 71-95 (the `project-binding`, `repository`, and `attempt` collection) are unchanged.

**`src/commands/provider/remove-provider.test.ts`**

Add the following module-level constants near the existing ULID constants (around line 37):

```ts
const LLM_PROVIDER_1_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2A";
const LLM_REGISTERED_1_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2B";
const LLM_DEFAULTSET_1_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2C";
const LLM_REMOVED_1_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2D";
const LLM_PROVIDER_2_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2E";
const LLM_REGISTERED_2_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2F";
const LLM_DEFAULTSET_2_ULID = "01HZY8QF3M4N5P6R7S8T9V0W2G";
const llmInput = {
  provider: "anthropic",
  apiKey: "sk-ant-x",
  defaultModel: "claude-opus-5",
  baseUrl: null,
} as const;
```

Add `force: false` to every existing call that passes `{ id, actor }` to `removeProvider` inside this file (the "blocked by all four causes" test at line 357, the two-project-bindings test at 410, two-repository test at 454, two-attempt test at 486, git-kind test at 521, unblocked-removal test at 554, throwing-event-append test at 592). Each becomes `{ id: providerId, actor: "ulrich", force: false }`.

Add the following six new `it` cases inside the existing `describe` block:

---

**Case A — stamped provider, `force: false` refuses with exactly `[{ kind: "default-chain" }]`.**

```ts
it("a stamped provider with no other blocker refuses with default-chain when force is false", (t) => {
  const temporary = createMigratedStorage();
  t.after(() => temporary.dispose());
  const ids = createMockIdGenerator({
    ulids: [PROVIDER_ULID, REGISTERED_ULID],
  });
  registerGitProvider(
    temporary.storage,
    ids,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  temporary.storage.transact((transaction) => {
    transaction.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [
      1700000000000,
      providerId,
    ]);
  });
  const deps = removeDependencies(
    temporary.storage,
    new SqliteEventLog({ storage: temporary.storage, ids }),
  );

  assert.throws(
    () =>
      removeProvider(deps, { id: providerId, actor: "ulrich", force: false }),
    (error: unknown) => {
      assert.ok(error instanceof RemoveProviderError);
      assert.equal(error.refusal, "binding-in-use");
      assert.deepEqual(error.blockers, [{ kind: "default-chain" }]);
      return true;
    },
  );
  assert.equal(countRows(temporary.storage, "provider"), 1);
});
```

---

**Case B — stamped provider, `force: true` succeeds, row is deleted, payload is exact.**

```ts
it("a stamped provider with no other blocker is removed when force is true", (t) => {
  const temporary = createMigratedStorage();
  t.after(() => temporary.dispose());
  const ids = createMockIdGenerator({
    ulids: [PROVIDER_ULID, REGISTERED_ULID, REMOVED_ULID],
  });
  registerGitProvider(
    temporary.storage,
    ids,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  temporary.storage.transact((transaction) => {
    transaction.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [
      1700000000000,
      providerId,
    ]);
  });
  const deps = removeDependencies(
    temporary.storage,
    new SqliteEventLog({ storage: temporary.storage, ids }),
  );

  const result = removeProvider(deps, {
    id: providerId,
    actor: "ulrich",
    force: true,
  });
  assert.deepEqual(result, { id: providerId });
  assert.deepEqual(Object.keys(result).sort(), ["id"]);
  assert.equal(countRows(temporary.storage, "provider"), 0);
  assert.equal(countRows(temporary.storage, "event"), 2);
  const removed = readEvents(temporary.storage).filter(
    (event) =>
      event.subject_id === providerId && event.type === "provider.removed",
  );
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.actor_kind, "human");
  assert.equal(removed[0]!.actor_id, "ulrich");
  assert.equal(removed[0]!.payload_json, '{"name":"github-bot","kind":"git"}');
});
```

---

**Case C — forced removal appends `provider.removed` only, no `provider.defaultUnset`.**

```ts
it("a forced removal of a stamped provider appends provider.removed and not provider.defaultUnset", (t) => {
  const temporary = createMigratedStorage();
  t.after(() => temporary.dispose());
  const ids = createMockIdGenerator({
    ulids: [PROVIDER_ULID, REGISTERED_ULID, REMOVED_ULID],
  });
  registerGitProvider(
    temporary.storage,
    ids,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  temporary.storage.transact((transaction) => {
    transaction.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [
      1700000000000,
      providerId,
    ]);
  });
  const deps = removeDependencies(
    temporary.storage,
    new SqliteEventLog({ storage: temporary.storage, ids }),
  );

  removeProvider(deps, { id: providerId, actor: "ulrich", force: true });
  const types = readEvents(temporary.storage)
    .filter((event) => event.subject_id === providerId)
    .map((event) => event.type);
  assert.deepEqual(types, ["provider.registered", "provider.removed"]);
});
```

---

**Case D — stamped provider with all four blockers, `force: true` refuses with three blockers in order.**

```ts
it("a stamped provider blocked by all four causes refuses with three blockers when force is true", (t) => {
  const temporary = createMigratedStorage();
  t.after(() => temporary.dispose());
  const ids = createMockIdGenerator({
    ulids: [PROVIDER_ULID, REGISTERED_ULID],
  });
  registerGitProvider(
    temporary.storage,
    ids,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  temporary.storage.transact((transaction) => {
    transaction.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [
      1700000000000,
      providerId,
    ]);
  });
  seedProjectBinding(
    temporary.storage,
    "project_p",
    "p-project",
    "provider",
    providerId,
  );
  seedAttemptFixture(temporary.storage, providerId, ["attempt_chain"]);
  const deps = removeDependencies(
    temporary.storage,
    new SqliteEventLog({ storage: temporary.storage, ids }),
  );

  assert.throws(
    () =>
      removeProvider(deps, { id: providerId, actor: "ulrich", force: true }),
    (error: unknown) => {
      assert.ok(error instanceof RemoveProviderError);
      assert.equal(error.refusal, "binding-in-use");
      assert.deepEqual(error.blockers, [
        { kind: "project-binding", projectId: "project_p" },
        { kind: "repository", repositoryId: "repository_chain" },
        { kind: "attempt", attemptId: "attempt_chain" },
      ]);
      return true;
    },
  );
  assert.equal(countRows(temporary.storage, "provider"), 1);
  assert.equal(countRows(temporary.storage, "event"), 1);
});
```

---

**Case E — unstamped provider, `force: true` and `force: false` produce the same result and event rows.**

```ts
it("an unstamped provider removed with force true and force false produces identical rows", (t) => {
  const ULIDS_E = [PROVIDER_ULID, REGISTERED_ULID, REMOVED_ULID];

  const temporaryA = createMigratedStorage();
  t.after(() => temporaryA.dispose());
  const idsA = createMockIdGenerator({ ulids: ULIDS_E });
  registerGitProvider(
    temporaryA.storage,
    idsA,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  const depsA = removeDependencies(
    temporaryA.storage,
    new SqliteEventLog({ storage: temporaryA.storage, ids: idsA }),
  );
  const resultA = removeProvider(depsA, {
    id: providerId,
    actor: "ulrich",
    force: false,
  });

  const temporaryB = createMigratedStorage();
  t.after(() => temporaryB.dispose());
  const idsB = createMockIdGenerator({ ulids: ULIDS_E });
  registerGitProvider(
    temporaryB.storage,
    idsB,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  const depsB = removeDependencies(
    temporaryB.storage,
    new SqliteEventLog({ storage: temporaryB.storage, ids: idsB }),
  );
  const resultB = removeProvider(depsB, {
    id: providerId,
    actor: "ulrich",
    force: true,
  });

  assert.deepEqual(resultA, { id: providerId });
  assert.deepEqual(resultB, { id: providerId });
  assert.equal(countRows(temporaryA.storage, "provider"), 0);
  assert.equal(countRows(temporaryB.storage, "provider"), 0);
  assert.deepEqual(
    readEvents(temporaryA.storage),
    readEvents(temporaryB.storage),
  );
});
```

---

**Case F — after forced removal of the only stamped `llm` provider, a new `llm` registration gets auto-stamped.**

Seed uses 7 ULIDs for the two LLM provider lifecycles. `registerProvider` calls `clock.now()` exactly once, so with `start: 1700000000000, step: 1000`, the first registration stamps at `1700000000000` and the second at `1700000001000`.

```ts
it("after forced removal of the stamped llm provider a new llm registration auto-stamps", (t) => {
  const temporary = createMigratedStorage();
  t.after(() => temporary.dispose());
  const ids = createMockIdGenerator({
    ulids: [
      LLM_PROVIDER_1_ULID, // provider ID for first llm registration
      LLM_REGISTERED_1_ULID, // event: provider.registered (first)
      LLM_DEFAULTSET_1_ULID, // event: provider.defaultSet (first)
      LLM_REMOVED_1_ULID, // event: provider.removed (forced removal)
      LLM_PROVIDER_2_ULID, // provider ID for second llm registration
      LLM_REGISTERED_2_ULID, // event: provider.registered (second)
      LLM_DEFAULTSET_2_ULID, // event: provider.defaultSet (second)
    ],
  });
  const clock = createMockClock({ start: 1700000000000, step: 1000 });
  const llmProvider1Id = `provider_${LLM_PROVIDER_1_ULID}`;
  const llmProvider2Id = `provider_${LLM_PROVIDER_2_ULID}`;

  // Step 1: register first llm provider (auto-stamps; set_default_at = 1700000000000)
  registerProvider(registerDependencies(temporary.storage, ids, clock), {
    name: "anthropic-bot",
    kind: "llm",
    payload: llmInput,
    actor: "ulrich",
  });

  // Step 2: force-remove the stamped provider (no clock tick)
  removeProvider(
    removeDependencies(
      temporary.storage,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    ),
    { id: llmProvider1Id, actor: "ulrich", force: true },
  );

  // Intermediate assertion: no stamped llm provider remains
  const countStamped = (
    temporary.storage.transact((tx) =>
      tx.get(
        "SELECT COUNT(*) AS c FROM provider WHERE kind = 'llm' AND set_default_at IS NOT NULL",
      ),
    ) as { c: number }
  ).c;
  assert.equal(countStamped, 0);

  // Step 3: register second llm provider (auto-stamps; set_default_at = 1700000001000)
  registerProvider(registerDependencies(temporary.storage, ids, clock), {
    name: "openai-bot",
    kind: "llm",
    payload: {
      provider: "openai",
      apiKey: "sk-x",
      defaultModel: "gpt-4o",
      baseUrl: null,
    },
    actor: "ulrich",
  });

  // Final assertion: second provider is stamped at the exact next clock tick
  const stampedRow = temporary.storage.transact((tx) =>
    tx.get("SELECT set_default_at FROM provider WHERE id = ?", [
      llmProvider2Id,
    ]),
  ) as { set_default_at: number };
  assert.equal(stampedRow.set_default_at, 1700000001000);
});
```

## Constraints

- `ProviderRemovalBlocker` union is unchanged. `{ kind: "default-chain" }` remains a member of the union and remains first in the fixed blocker-collection order (lines 68-70 before 71-95).
- The command still reads `target.set_default_at` on every call. The read does not move inside the `!input.force` guard.
- Append no `provider.defaultUnset` event on any path. The event payload of `provider.removed` is unchanged: `{ name, kind }`.
- The "blocked by all four causes" test at line 357 must pass unchanged once `force: false` is added to its `removeProvider` call. Its assertion that `blockers` deep-equals the four-entry array (including `default-chain` first) remains correct.
- EPIC 101 Proof at `.agents/plan/epics/101-credential-registry-completion.md:61` runs this test file; it must still exit 0.

## Verify

- `node --test src/commands/provider/remove-provider.test.ts` exits 0.
- Do NOT run `npm run verify` at this story's completion. Stories 1 and 3 are a coupled pair: `npm run verify` runs after Story 3 is complete (the handler must pass `force` before TypeScript type-check passes across the full codebase).
- Proof: delivers `src/commands/provider/remove-provider.test.ts` from the EPIC-042 Proof block.
