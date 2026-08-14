# Story 12 — The second consumption assertion

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Stories 4, 7, 9, 11. `.agent/plan/stories/014-external-drive-contract/15-trigger-consumer-map.md:30` assigns this assertion to EPIC 019, because EPIC 019 creates the consumer files.

This is the second half of the EPIC bullet at `019-outcome-report.md:66`. Story 4 landed the rows and the map entries; this story lands the on-disk assertion, and it runs only after the four command files exist.

## Change

None in production code. This story adds test code only.

## Verify

Add one nested `describe("externalTriggerConsumer on disk", ...)` to `src/domain/external-transition.test.ts`. It imports `readFileSync` and `existsSync` from `node:fs` and resolves each path against the repository root, derived from `import.meta.url` and no hard-coded absolute path.

- `it("every consumer path exists on disk", ...)` — iterate `Object.entries(externalTriggerConsumer)`, assert `existsSync(resolved)` for each, and put the trigger id and the path in the assertion message. The assertion is total over the trigger ids and it fails when one file is absent.
- `it("every consumer file holds its own trigger id as a literal", ...)` — read each named file and assert the file content includes the trigger id inside double quotes, for example `"attempt-failed"`. Assert it for all ten entries.
- `it("no consumer path names aggregate-objective", ...)` — assert no value equals or contains `src/commands/outcome/aggregate-objective.ts`, and assert `existsSync` is `false` for that path.
- `it("the assertion read at least one file", ...)` — assert the number of files read equals `new Set(Object.values(externalTriggerConsumer)).size` and that the number is greater than zero.
- **No source scan over `src/commands/` exists.** `014-external-drive-contract.md:50` deletes it. Do not add one.
- `node --test src/domain/external-transition.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/domain/external-transition.test.ts`. Hermetic coverage: `019-outcome-report.md:167`.
