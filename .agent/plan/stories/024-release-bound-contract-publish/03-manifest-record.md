# Story 3 — The manifest record

Epic: `.agent/plan/epics/024-release-bound-contract-publish.md`

## Change

- `scripts/publish-contract.ts:13-17`. Replace `dirty: boolean` with `tag: string | null`:

```ts
export type PublishInput = Readonly<{
  outputDirectory: string;
  commit: string;
  tag: string | null;
}>;
```

- `scripts/publish-contract.ts:98-104`. The manifest object literal declares its five keys in this
  exact source order, because `JSON.stringify` emits insertion order:

```ts
const manifest = {
  version: KANTHORD_VERSION,
  commit: input.commit,
  tag: input.tag,
  features: features.map((feature) => feature.name),
  operations: publishedEntries.map((entry) => entry.operationId),
};
```

- Change nothing else in `publishContract`. The document emission at `:59-96`, the stale-file removal
  at `:43-52` and the bytewise sort at `:112` stay unedited.

## Constraints

- `dirty` disappears from the source. No compatibility key, no alias.
- The serialization stays `` `${JSON.stringify(manifest, null, 2)}\n` `` at `:107`.

## Verify

Edit `scripts/publish-contract.test.ts`:

- `:117-123` — the key list becomes `["version", "commit", "tag", "features", "operations"]`.
- `:124` — replace `assert.equal(typeof manifest.dirty, "boolean")` with an assertion on the raw JSON
  text that the five keys appear in that order, so a serializer that emits the right values in the
  wrong order fails:
  `assert.match(raw, /"version"[\s\S]*"commit"[\s\S]*"tag"[\s\S]*"features"[\s\S]*"operations"/)`.
- `:130-135` — the existing "carries no timestamp" test gains one line:
  `assert.doesNotMatch(raw, /"[^"]*dirty[^"]*"\s*:/i)`.
- `:184-210` "generation is byte-identical across two runs" — both `publishContract` calls pass
  `tag: "v27.8.1"` in place of `dirty: false`. The two runs stay byte-identical.
- `:212-232` "the manifest records a dirty tree" — rename the test to
  `"the manifest records an unreleased artifact"`. Publish twice with the same
  `commit = "0".repeat(40)`: once with `tag: "v27.8.1"` and once with `tag: null`. Assert the
  `tag: null` manifest parses with `manifest.tag === null`, the released manifest parses with
  `manifest.tag === "v27.8.1"`, and the two manifest byte buffers differ by `assert.notDeepEqual`.
- `:276-280` "clears a stale file" — the `publishContract` call passes `tag: null` in place of
  `dirty: false`.
- Leave `:92` (`exampleFiles.length === 34`) and `:71-88` (per-feature operation sets plus
  `SwaggerParser.validate`) unedited. They prove the epic changed the manifest and nothing else.

This story does not verify alone. Its type change breaks the CLI block that Story 4 rewrites.
Stories 2, 3 and 4 are one dispatch unit with one verification at the end of Story 4.

- `node --test scripts/publish-contract.test.ts` exits 0 after Story 4 lands.
- `npm run verify` exits 0 after Story 4 lands.
- Proof: `scripts/publish-contract.test.ts` in the EPIC Proof block.
