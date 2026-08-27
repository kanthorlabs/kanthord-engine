# Story 7 — Assert the socket budget

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Depends on: Story 6.

## Change

### `test/helpers/socket-budget.test.ts` — new file

- Import `readdir` and `readFile` from `node:fs/promises`.
- Import `Buffer` from `node:buffer`, path helpers, `fileURLToPath`, `node:test`, and `node:assert/strict`.
- Resolve the repository root from `new URL("../../", import.meta.url)`.
- Recursively read both `<root>/src` and `<root>/test` with `readdir(root, { recursive: true })`.
- Keep only entries ending in `.test.ts`.
- Read each source and inspect import declarations only.
- Extract declarations with `/^\s*import\s+(?:type\s+)?[^;]*?\sfrom\s+["'][^"']+["'];/gms`.
- Test each extracted declaration with `/\b(?:loopbackAgent|loopbackServer|createSocketTestApp)\b/`.
- Match an import when its declaration names `loopbackAgent`, `loopbackServer`, or `createSocketTestApp`.
- Do not match comments, ordinary expressions, or string literals outside import declarations.
- Convert each match to a repository-relative path and replace `\\` with `/`.
- Sort paths bytewise with `Buffer.compare(Buffer.from(left), Buffer.from(right))`.
- Name the suite `test/helpers/socket-budget.test counts files that reach test/helpers/agent.ts`.
- Add exactly two cases.
- Case 1 is `keeps the socket file count at seven`; assert the collected length equals 7.
- Case 2 is `keeps the exact level-2 allow list`; deep-equal the sorted list below.

```ts
[
  "src/http/server/app.handler-result.test.ts",
  "src/http/server/app.test.ts",
  "src/http/server/blob/show-blob.test.ts",
  "src/http/server/host.test.ts",
  "src/http/server/idempotency.test.ts",
  "src/http/server/shutdown-socket.test.ts",
  "test/helpers/agent.test.ts",
];
```

- Implement one `socketFiles(root: string): Promise<readonly string[]>` scan function.
- Call `socketFiles(repositoryRoot)` once in each case. Derive no expected path from results.
- Read each of `src` and `test` with its own `readdir` call. Prefix each returned entry with that
  directory name to build the repository-relative path.

## Constraints

- Add exactly two cases and no production file.
- Treat the seven paths as a closed allow list. Derive level 1 as every other harness-backed test.
- Do not scan non-test files. `test/helpers/app.ts` must remain outside the result.
- Do not depend on directory enumeration order or the current working directory.
- Do not add an exclusion that hides an eighth socket-backed test.
- Add no special case for `src/main.claim.test.ts`. It names `createTestApp` in a string at
  `src/main.claim.test.ts:628`, and the scan searches neither that name nor a string literal.

## Verify

- Run `node --test test/helpers/socket-budget.test.ts`.
- The command passes exactly two cases and reports the exact seven paths.
- Record the final `node --test 2>&1 | grep -m1 'ℹ pass'` value. `scripts/run-tests.mjs` selects
  the spec reporter, which writes `ℹ pass <n>` and never `# pass`.
- The final value equals the base-commit value plus 21. The review addendum of the EPIC adds 3
  more after this story, so the closing value is the base-commit value plus 24.
- Run `npm run verify`; it exits 0.
- Run the EPIC Proof block verbatim:

```bash
node --test \
  test/helpers/agent.test.ts \
  test/helpers/app.test.ts \
  test/helpers/socket-budget.test.ts \
  src/http/server/app.test.ts \
  src/http/server/app.handler-result.test.ts \
  src/http/server/app.parity-path.test.ts \
  src/http/server/auth.test.ts \
  src/http/server/authorize.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/envelope.test.ts \
  src/http/server/host.test.ts \
  src/http/server/idempotency.test.ts \
  src/http/server/idempotency-key.test.ts \
  src/http/server/idempotency-response.test.ts \
  src/http/server/origin.test.ts \
  src/http/server/preflight.test.ts \
  src/http/server/route.test.ts \
  src/http/server/shutdown.test.ts \
  src/http/server/shutdown-socket.test.ts \
  src/http/server/blob/show-blob.test.ts \
  src/http/server/blob/range.test.ts \
  src/http/server/event/list-event.test.ts \
  src/http/server/event/wait.test.ts \
  src/http/server/system/health.test.ts \
  src/http/server/system/status.test.ts \
  src/http/server/system/db.test.ts \
  src/http/server/actor/registration.test.ts \
  src/http/server/credential/register-provider.test.ts \
  src/http/server/node/claim-node.test.ts \
  src/http/server/plan/import-plan.test.ts \
  src/http/server/project/show-project-graph.test.ts \
  src/http/server/repository/register-repository.test.ts \
  src/main.claim.test.ts \
  && echo "PASS EPIC-033"
```

- The final command prints `PASS EPIC-033`.
- Proof: delivers `test/helpers/socket-budget.test.ts` and owns the complete Proof block.
- Proof: delivers the exact socket count, exact allow list, and total pass-count gate bullets.
