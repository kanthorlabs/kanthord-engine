# Story 2 — Node-write and repository-name refusals carry their details

Epic: `.agents/plan/epics/040-project-management-cli-ergonomics.md`
Depends on: Story 1 only by dispatch order.

## Change

### New `src/cli/node/write-refusal.ts`

- Export `printNodeWriteRefusal(result, stderr): void`.
- Type `result` as the failed member of `CallResult` from `src/cli/client.ts`; accept no successful member.
- Always write `kanthord: ${result.code}: ${result.message}\n` first.
- Return after that line when `result.code !== "plan-invalid"`.
- For `plan-invalid`, parse `result.details` with `planInvalidDetails` from `src/http/contract/error-details.ts:84-86`. Iterate `details.findings` in response order and write one exact line per finding:
  `kanthord: plan-invalid: ${finding.code} ${finding.path ?? "-"} ${finding.message}\n`.
- Do not catch a parse failure. Malformed details are a contract breach and must throw rather than print an incomplete diagnosis.

### Wire all three node-write CLIs

- In `src/cli/node/create.ts:171-176`, replace only the generic stderr write with `printNodeWriteRefusal(createResult, input.stderr)`; preserve `exitCodeForError` and return.
- In `src/cli/node/update.ts:202-207`, make the same replacement for `updateResult`.
- In `src/cli/node/delete.ts:67-72`, make the same replacement for `deleteResult`.
- Add one import of the helper to each file. Do not change success/completeness rendering.

### `src/cli/project/repository.ts:59-67`

- Import `comparePaths` from `src/domain/plan-path.ts`.
- Immediately after parsing `repositoryListResponse`, derive `knownNames` by mapping every repository name, deduplicating with `Set`, sorting with `comparePaths`, and joining with `,`; render `<none>` when the result is empty.
- Keep name matching exact and case-sensitive.
- Replace the refusal at `:63` with one exact line:
  `kanthord: not-found: no repository named ${name}; known repositories: ${knownNames}\n`.
- On this branch call `input.fail()` once and call no `project.repositories` operation.

### Proposal

- In `docs/proposal/api/graph.md`, add one shared paragraph after the `node.delete` failure paragraph at `:186`: the structural-finding behavior applies to create, update and delete, and the CLI prints the generic `plan-invalid` line followed by every `details.findings` member in response order.
- In `docs/proposal/api/project.md`, append one paragraph to `project.repositories` after `:34`: the CLI resolves names from `repository.list`, and an unknown exact name prints all known names deduplicated and bytewise-sorted before writing nothing.
- Run Prettier on both proposal files.

## Constraints

- Do not alter daemon envelopes, finding schemas, finding order or exit codes.
- Do not print `result.details` as raw JSON.
- Do not sort findings; response order is contract order.
- Do not add a second `repository.list` call.

## Verify

- Add `src/cli/node/write-refusal.test.ts`:
  - a non-`plan-invalid` stale-revision result prints exactly one generic line;
  - a `plan-invalid` result with two valid findings prints the generic line and both exact finding lines in supplied order, including `-` for a null path;
  - malformed `plan-invalid` details throw a zod error after the generic first line and never print a synthetic empty list.
- Extend `src/cli/node/create.test.ts`, `update.test.ts` and `delete.test.ts` with one `plan-invalid` script each. Assert the helper's generic-plus-finding bytes and the existing exit code `160`; keep each stale-revision test unchanged.
- Extend `src/cli/project/repository.test.ts`:
  - replace the existing unknown-name expected line with the new form;
  - return names in order `zeta`, `alpha`, `zeta` and assert `alpha,zeta` once;
  - return an empty list and assert `<none>`;
  - in both cases assert exactly one `repository.list` call and no `project.repositories` call.
- `node --test src/cli/node/write-refusal.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/project/repository.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: the five matching test-file lines of the EPIC Proof; the final sentinel is delivered collectively.
