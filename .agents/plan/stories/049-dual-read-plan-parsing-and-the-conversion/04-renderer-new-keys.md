# Story 4 — Renderer emits new keys

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Story 1 (`ParsedDocument` carries `deliverable` and `verify`), EPIC 047 (`VerifyBlock` type from `src/domain/verify-block.ts`)

## Change

**`src/domain/plan-render.ts` — `RenderInput` (lines 6-15)**

Add two fields to the `Readonly<{...}>` type alias:

- `deliverable: Deliverable | null` — import `Deliverable` from `"./deliverable.ts"`.
- `verify: VerifyBlock | null` — import `VerifyBlock` from `"./verify-block.ts"`.

**`src/domain/plan-render.ts` — `renderDocument` (lines 41-61)**

Replace the body of the `lines` construction with two branches:

Branch A — new-shape document (`input.deliverable !== null`). Emit these keys in this exact order, omitting keys whose value is empty or absent:

1. `---`
2. `id: ${quoteScalar(input.identity)}`
3. `kind: ${quoteScalar(input.kind)}`
4. `title: ${quoteScalar(input.title)}`
5. `deliverable: ${quoteScalar(input.deliverable)}`
6. `repo: ${quoteScalar(input.repo)}` — only if `input.repo !== null`
7. `depends_on:` block — only if `input.dependencies.length > 0`; each entry as `  - ${quoteScalar(dep)}`, sorted by `comparePaths`
8. `verify:` block — always present if `deliverable !== null`; render as:
   ```
   verify:
     paths:
       - <quoteScalar(path)>   ← one line per entry; or "  paths: []" if empty
     commands:
       - <quoteScalar(cmd)>    ← one line per entry; or "  commands: []" if empty
   ```
   Exact rendering rules:
   - If `input.verify.paths.length === 0`: emit the literal line `  paths: []`
   - If `input.verify.paths.length > 0`: emit `  paths:` then one `    - ${quoteScalar(p)}` line per path
   - If `input.verify.commands.length === 0`: emit the literal line `  commands: []`
   - If `input.verify.commands.length > 0`: emit `  commands:` then one `    - ${quoteScalar(c)}` line per command
9. `---`

Branch B — legacy document (`input.deliverable === null`). Keep the existing key order unchanged: `id`, `kind`, `title`, `depends_on` (if any), `worker` (if any), `repo` (if any). `verify` is not emitted.

**`src/domain/plan-render.ts` — callers of `renderDocumentSet`**

`renderDocumentSet` (lines 72-111) builds `RenderInput` from the `bodies` map. Extend the map value type and the construction site to pass `deliverable` and `verify` from the bodies map entry. The bodies map key is the node `id`, and the entry currently carries `{ instruction, acceptance, worker, repo }`. Add `deliverable: Deliverable | null` and `verify: VerifyBlock | null`.

## Constraints

- The `"---"` fence lines are plain strings. Do not quote them.
- `quoteScalar` is applied to every user-supplied string value. Do not emit a bare unquoted value.
- `worker` is emitted only in Branch B. A new-shape document never emits `worker`.
- The `verify` block indentation is exactly two spaces for `paths:` / `commands:` and four spaces for each list entry.
- An empty list renders on one line: `  paths: []` or `  commands: []`. No multi-line form for an empty list.

## Verify

```
node --test src/domain/plan-render.test.ts
```

Add to `src/domain/plan-render.test.ts`:

1. `"renders a new-shape task to the exact bytes"` — `RenderInput` with `kind: "task"`, `title: "Render JSON"`, `identity: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"`, `deliverable: "test"`, `repo: null`, `dependencies: []`, `verify: { paths: ["src/foo.ts"], commands: ["! node --test src/foo.test.ts"] }`, `worker: null`, `instruction: "Do the thing.\n"`, `acceptance: null`. Assert `renderDocument(input)` equals the exact string (assert with `assert.equal`):

   ```
   ---
   id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"
   kind: "task"
   title: "Render JSON"
   deliverable: "test"
   verify:
     paths:
       - "src/foo.ts"
     commands:
       - "! node --test src/foo.test.ts"
   ---
   Do the thing.
   ```

   (The string ends with one `\n` after `Do the thing.`)

2. `"renders an empty verify block as two single-line lists"` — `RenderInput` with `kind: "task"`, `title: "Empty verify"`, `identity: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"`, `deliverable: "test"`, `repo: null`, `dependencies: []`, `verify: { paths: [], commands: [] }`, `worker: null`, `instruction: "Do the thing.\n"`, `acceptance: null`. Assert `renderDocument(input)` byte-equals the exact string (use `assert.equal`):

   ```
   ---
   id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"
   kind: "task"
   title: "Empty verify"
   deliverable: "test"
   verify:
     paths: []
     commands: []
   ---
   Do the thing.
   ```

   (The string ends with one `\n` after `Do the thing.`)

3. `"a command string holding a quote, backslash and tab survives a round trip byte-identically"` — input command string `'say "hello"\there\\done'` (a string containing a double-quote, a tab character, and a backslash). Build a `RenderInput` for a task with `verify: { paths: [], commands: [cmd] }` and `deliverable: "test"`. Call `renderDocument(input)` to produce a YAML text. Then parse that text through the frontmatter reader (import `DocumentService` from `"../../services/document/index.ts"` and call `new DocumentService().read(text)` to get `{ frontmatter, body }`; then access `frontmatter.verify.commands[0]`). Assert the recovered command equals the original `cmd` byte-for-byte with `assert.equal`. This is the real round-trip: render → parse → compare, not `JSON.parse(quoteScalar(cmd))` alone.

4. `"renders a new-shape objective with repo and no dependencies"` — `kind: "objective"`, `deliverable: "expansion"`, `repo: "kanthord-apps"`, `dependencies: []`, `verify: { paths: [], commands: [] }`. Assert the rendered frontmatter contains `deliverable: "expansion"` before `repo:` before `verify:`, and contains no `worker:` line.

5. `"a legacy task still renders with worker and no deliverable or verify"` — `deliverable: null`, `verify: null`, `worker: "claude.swe@1"`. Assert the rendered frontmatter contains `worker: "claude.swe@1"` and contains no `deliverable:` or `verify:` line.

6. `"renders worker.md section 2 example 1 — initiative — byte-exact"` — `RenderInput` with `identity: "initiative_01m13wjg401jqj8xezaph3s633"`, `kind: "initiative"`, `title: "Provider CRUD"`, `deliverable: "expansion"`, `repo: null`, `dependencies: []`, `verify: { paths: [], commands: [] }`, `worker: null`, `instruction: "Body.\n"`, `acceptance: null`. Assert `renderDocument(input)` equals the exact string with `assert.equal`:

   ```
   ---
   id: "initiative_01m13wjg401jqj8xezaph3s633"
   kind: "initiative"
   title: "Provider CRUD"
   deliverable: "expansion"
   verify:
     paths: []
     commands: []
   ---
   Body.
   ```

   (One trailing `\n` after `Body.`)

7. `"renders worker.md section 2 example 2 — objective with repo and depends_on — byte-exact"` — `RenderInput` with `identity: "objective_01m13wjg4185jk8p3pdvzt2spv"`, `kind: "objective"`, `title: "Contract types"`, `deliverable: "implementation"`, `repo: "kanthord-apps"`, `dependencies: ["objective_01m14b2k7x9qd3vs5nfh8tzg42"]`, `verify: { paths: [], commands: [] }`, `worker: null`, `instruction: "Body.\n"`, `acceptance: null`. Assert `renderDocument(input)` equals the exact string with `assert.equal`:

   ```
   ---
   id: "objective_01m13wjg4185jk8p3pdvzt2spv"
   kind: "objective"
   title: "Contract types"
   deliverable: "implementation"
   repo: "kanthord-apps"
   depends_on:
     - "objective_01m14b2k7x9qd3vs5nfh8tzg42"
   verify:
     paths: []
     commands: []
   ---
   Body.
   ```

   (One trailing `\n` after `Body.`)

8. `"renders worker.md section 2 example 3 — task with paths and inverted command — byte-exact"` — `RenderInput` with `identity: "task_01m13ymgvfq91nbjqbs9kgxk2n"`, `kind: "task"`, `title: "Projection union — test"`, `deliverable: "test"`, `repo: null`, `dependencies: []`, `verify: { paths: ["apps/dashboard/src/api/types.test.ts"], commands: ["! pnpm --filter @kanthord/dashboard test src/api/types.test.ts"] }`, `worker: null`, `instruction: "Body.\n"`, `acceptance: null`. Assert `renderDocument(input)` equals the exact string with `assert.equal`:

   ```
   ---
   id: "task_01m13ymgvfq91nbjqbs9kgxk2n"
   kind: "task"
   title: "Projection union — test"
   deliverable: "test"
   verify:
     paths:
       - "apps/dashboard/src/api/types.test.ts"
     commands:
       - "! pnpm --filter @kanthord/dashboard test src/api/types.test.ts"
   ---
   Body.
   ```

   (One trailing `\n` after `Body.`)

9. `"renders worker.md section 2 example 4 — implementation task with depends_on — byte-exact"` — `RenderInput` with `identity: "task_01m13ymgvgywcy5x323zygnec1"`, `kind: "task"`, `title: "Projection union"`, `deliverable: "implementation"`, `repo: null`, `dependencies: ["task_01m13ymgvfq91nbjqbs9kgxk2n"]`, `verify: { paths: ["apps/dashboard/src/api/types.ts"], commands: ["pnpm --filter @kanthord/dashboard test src/api/types.test.ts"] }`, `worker: null`, `instruction: "Body.\n"`, `acceptance: null`. Assert `renderDocument(input)` equals the exact string with `assert.equal`:
   ```
   ---
   id: "task_01m13ymgvgywcy5x323zygnec1"
   kind: "task"
   title: "Projection union"
   deliverable: "implementation"
   depends_on:
     - "task_01m13ymgvfq91nbjqbs9kgxk2n"
   verify:
     paths:
       - "apps/dashboard/src/api/types.ts"
     commands:
       - "pnpm --filter @kanthord/dashboard test src/api/types.test.ts"
   ---
   Body.
   ```
   (One trailing `\n` after `Body.`)

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/domain/plan-render.test.ts` in `PASS EPIC-049`. Hermetic coverage: new-shape byte-exact render; empty verify block; special-char real round-trip through render and parse; worker.md section 2 examples 1–4 byte-exact with key order reproduced; legacy document unchanged.
