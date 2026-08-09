# Story 05 — A scenario touches the product through the CLI and HTTP only

Epic: `.agent/plan/epics/011.1-acceptance-run-preconditions.md`

## Change

One test file. No production file changes.

`scripts/e2e/lib/scenario/discipline.test.ts` — add one `test` after the existing
`ScenarioContext carries no releaseAll key` case (ends at line 62):

```ts
test("no scenario file imports from src/", async () => {
  const directory = resolve(import.meta.dirname);
  const sourceRoot = resolve(import.meta.dirname, "../../../../src");
  const files: string[] = [];

  for await (const entry of glob("*.ts", { cwd: directory })) {
    if (entry.endsWith(".test.ts")) {
      continue;
    }
    files.push(entry);
  }

  assert.ok(files.length > 0, "expected at least one scenario file to check");

  for (const file of files) {
    const text = await readFile(resolve(directory, file), "utf8");
    const specifiers = [
      ...text.matchAll(/from\s+"([^"]+)"/g),
      ...text.matchAll(/import\s*\(\s*"([^"]+)"/g),
    ].map((match) => match[1] as string);

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolve(directory, specifier);
      assert.equal(
        resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${sep}`),
        false,
        `${file} imports ${specifier}, which resolves into src/`,
      );
    }
  }
});
```

Add `sep` to the existing `node:path` import at line 4.

The enumeration matches the file's existing discipline test at lines 19-41: `glob("*.ts")` over
`scripts/e2e/lib/scenario/`, non-recursive, skipping `*.test.ts`.

## Constraints

- Only `src/` is forbidden. `scripts/e2e/lib/scenario/p1-e4.ts:4-5` imports
  `../../../../test/helpers/remote/...` and must keep passing — the fixture harness is the remote,
  not the product.
- The scan covers production scenario files only, the same set the existing forbidden-token test
  covers. `journey.test.ts:18-19` and `p1-e3.test.ts:29` import `src/services/config/search-order.ts`
  and `src/domain/version.ts` today; this story does not change them.
- Do not move or rewrite the existing two tests in the file.

## Verify

- `node --test scripts/e2e/lib/scenario/discipline.test.ts` — passes, three cases.
- Regression guard, run by hand and reverted, not committed: add
  `import { rows } from "../../../../src/domain/rows.ts";` to
  `scripts/e2e/lib/scenario/p1-e1.ts`, confirm the new case fails naming `p1-e1.ts`, then revert.
- `npm run verify` exits 0.
- Proof: this story delivers no line of the EPIC Proof block. It is covered by the
  `Coverage required beyond the Proof` bullet "No file under `scripts/e2e/lib/scenario/` imports
  from `src/`."
