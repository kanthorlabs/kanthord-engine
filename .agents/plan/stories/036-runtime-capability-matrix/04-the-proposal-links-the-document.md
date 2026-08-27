# Story 4 — The proposal links the document

Epic: `.agents/plan/epics/036-runtime-capability-matrix.md`
Depends on: Story 1 — it links a file that must already exist.

Documentation only. No file under `src/`, `test/` or `scripts/` changes.
`docs/proposal/*` is the software-engineer lane (`scripts/lane-check.sh:99-101`). The test-engineer
writes nothing for this story.

Three edits, in three files. Each inserts one line or one paragraph and changes nothing else.

## Change

### Edit 1 — `docs/proposal/README.md`

The Files table spans lines 124 to 141. Line 128 reads today:

```
| [phase-1/transport.md](phase-1/transport.md)                                 | bind address, bearer token, browser defences, CLI parity      | architect and whoever owns the network  |
```

Insert one new line **directly after line 128**, so the new row becomes line 129 and the former
line 129 (`api/README.md`) becomes line 130:

```
| [phase-1/runtime-capability-matrix.md](phase-1/runtime-capability-matrix.md) | per-operation runtime verdicts, deployment shapes              | architect and whoever owns the network  |
```

The table has three columns — `File`, `Subject`, `Suggested reviewer` — declared at line 124. Change
no other line of the file, and change no cell of line 128.

### Edit 2 — `docs/proposal/phase-1/README.md`

The Files table spans lines 17 to 24. Line 21 reads today:

```
| [transport.md](transport.md)                   | bind address, bearer token, browser defences, CLI parity                     |
```

Insert one new line **directly after line 21**, so the new row becomes line 22 and the former line 22
(`plan-format.md`) becomes line 23:

```
| [runtime-capability-matrix.md](runtime-capability-matrix.md) | per-operation runtime verdicts, deployment shapes |
```

This table has **two** columns — `File` and `Subject` — declared at line 17. It carries no reviewer
column, so the new row carries no reviewer cell. Change no other line of the file.

### Edit 3 — `docs/proposal/phase-1/transport.md`

The section `## HTTP is the surface, the CLI calls it` opens at line 5. Its last line is line 10,
which reads today:

```
The version compatibility policy — what `/v1` guarantees, what a client must tolerate, and the `GET /v1/health` handshake that carries the capability list — is `../api/README.md`, section `## Versioning`.
```

Line 11 is blank and line 12 is the next heading, `## The CLI exit code names the refusal class`.

Insert **directly after line 10** one blank line and then this paragraph, so the new paragraph becomes
line 12 and the existing blank line and heading follow it:

```
Which operation runs on which runtime is `runtime-capability-matrix.md`, not this file. It holds one row per routed operation, with a verdict for the Node daemon, for AWS Lambda and for Cloudflare Workers, and it is the source of truth for that question.
```

Change no other line. Leave lines 1 to 10 and the heading at the former line 12 byte-identical.

### Formatting

**Prettier will re-pad every row of both tables, and that is expected.** The new row in
`docs/proposal/phase-1/README.md` is longer than the current widest cell of its `File` column, so
prettier widens the column and rewrites the whitespace of all six existing rows. `docs/proposal/README.md`
may re-pad the same way.

That is the one exception to `change no other line` in this story: **a whitespace-only change to an
existing table row is expected and permitted; a change to the text of any existing cell is not.**
Check the two apart:

```bash
git diff --ignore-all-space docs/proposal/README.md docs/proposal/phase-1/README.md
```

That diff must show the two added rows and nothing else. If it shows a change to an existing row's
text, revert and redo the insertion.

Run the formatter and read the diff:

```bash
npx prettier --write docs/proposal/README.md docs/proposal/phase-1/README.md docs/proposal/phase-1/transport.md
```

## Constraints

- **Insert directly under the transport row in both tables.** The EPIC fixes the position. Do not
  sort the row alphabetically into the table; neither table is sorted.
- **The two tables have different column counts.** `docs/proposal/README.md` has three columns and
  `docs/proposal/phase-1/README.md` has two. A three-column row in the two-column table breaks the
  markdown table.
- **The subject text is `per-operation runtime verdicts, deployment shapes`** in both tables, and the
  reviewer is `architect and whoever owns the network`. Both are fixed by the EPIC.
- **Change the text of no other Files-table row**, and change no reviewer of an existing row.
  Prettier's whitespace re-padding of an existing row is not a text change and is expected.
- **`docs/proposal/README.md` is read by a live test.** `test/helpers/remote/index.test.ts:130-184`
  parses the `deterministic` mode description out of this file and asserts its transport vocabulary
  is exactly `["git", "HTTP", "ssh", "sshd"]`. That description is not in the Files table, so
  Edit 1 must leave it untouched.
- **`docs/proposal/phase-1/README.md` is read by a live test.** `src/cli/inventory.test.ts:20`
  resolves and scans this file for CLI commands. The new row names no command, so the scan yields
  the same set. Do not put a `kanthord` command word in the new row.
- Touch the matrix document itself in no way. Stories 1, 2 and 3 own every line of it.

## Verify

```bash
node --test src/cli/inventory.test.ts test/helpers/remote/index.test.ts src/http/contract/parity.test.ts
```

- `inventory.test.ts` passes unchanged. Both P1-E1 scans yield the same command set as before.
- `test/helpers/remote/index.test.ts` passes unchanged. The `deterministic` mode line is untouched.
- `parity.test.ts` passes unchanged. This story adds no route row to any `api/*.md`.
- `git diff --name-only` names exactly three files: `docs/proposal/README.md`,
  `docs/proposal/phase-1/README.md`, `docs/proposal/phase-1/transport.md`.
- Each of these reports `1`:

```bash
grep -c 'runtime-capability-matrix' docs/proposal/README.md
grep -c 'runtime-capability-matrix' docs/proposal/phase-1/README.md
grep -c 'runtime-capability-matrix' docs/proposal/phase-1/transport.md
```

- The new row sits under the transport row in both tables:

```bash
grep -n -A1 'phase-1/transport.md' docs/proposal/README.md | grep -c 'runtime-capability-matrix'      # 1
grep -n -A1 '\[transport.md\]' docs/proposal/phase-1/README.md | grep -c 'runtime-capability-matrix'  # 1
```

- `git diff --ignore-all-space docs/proposal/README.md docs/proposal/phase-1/README.md` shows
  exactly two added lines and no other change. Whitespace re-padding of existing rows does not
  appear in this diff, which is why it is the check that matters.
- `git diff docs/proposal/phase-1/transport.md` shows one added blank line and one added paragraph,
  inside the section that opens at line 5, and touches no other line. `transport.md` holds no table,
  so prettier re-pads nothing there and this diff is exact.
- The link resolves: `test -f docs/proposal/phase-1/runtime-capability-matrix.md` exits 0.

`npm run verify` exits 0.

Proof: this story delivers no `node --test` clause of the EPIC Proof on its own. `docs/proposal/README.md`
is the index of the source of truth, so an unlinked document is an unfindable one.
