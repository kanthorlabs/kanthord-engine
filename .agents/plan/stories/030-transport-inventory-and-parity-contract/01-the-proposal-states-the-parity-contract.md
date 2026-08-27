# Story 1 — The proposal states the parity contract

Epic: `.agents/plan/epics/030-transport-inventory-and-parity-contract.md`

Documentation only. No file under `src/`, `test/` or `scripts/` changes.

`docs/proposal/*` is the software-engineer lane (`scripts/lane-check.sh:99`). The test-engineer
writes nothing for this story.

## Change

### `docs/proposal/phase-1/transport.md`

The file is **98 lines**. `## Browser access` opens at line 74 and its last line is 86.
`## A held request` opens at line 88. Line 87 is blank.

**Edit 1 — one new section.** Insert the block below between line 87 and line 88, so the new `##`
heading follows the blank line at 87 and one blank line separates the block from `## A held request`.
Change no existing line of the file.

```
## The request and response contract

This section states what a client observes at the boundary. It names no library, and a replacement
transport reproduces every rule below without changing a single observable byte.

**An absent request body is an empty object.** A write reaches its operation with an empty body in
three cases: the client sends no body, the content type is not JSON, and the body has zero length.
The transport refuses none of the three on its own. Each operation validates its own body, so a
missing field is that operation's own `400`, carrying that operation's own message.

**A body is read only for an operation this build implements.** An operation of `../api/README.md`
that ships in a later phase, and an operation this build declares unimplemented, both answer `501`
with the body unread. A malformed payload therefore never turns a `501` into a `400`, and the answer
to an unimplemented operation does not depend on what the client sent.

**The browser headers survive every refusal.** The allow-origin header and the expose-headers header
are written before the operation runs, so they are present on the answer whatever it turns out to be:
an unauthenticated refusal, an unmatched path, a precondition refusal, and an internal fault each
carry them. One answer carries neither, and it is the refusal of an origin outside the allow list.
That refusal is decided before any header is written.

**`Vary: Origin` covers every answer the daemon completes.** It is present when the request carries
an allowed origin, when the request carries no origin at all, and on the preflight answer. The single
answer without it is the refusal of an origin outside the allow list.

**A path segment is never decoded.** Route matching compares the literal characters between two
slashes. An escape inside a path parameter reaches the operation as the characters the client wrote,
and a malformed escape reaches route matching intact rather than producing a transport refusal.

**A request header reaches the operation once, under a lower-case name.** A name the client sends
twice arrives as one value, with the two values joined by a comma and a space. The operation reads
one string per name, and the names arrive in byte order.

**An answer carries one of two success statuses.** Every operation answers `200`, and the one
operation that serves a byte range answers `206` as well. No other success status exists in the
product.

**One operation writes response headers, and it is the one that serves bytes.** Every other operation
answers with a status and a body alone. A structured answer is JSON. A byte answer carries its exact
length, and a range answer carries its exact range.

**One answer in the product has an empty body, and it is the preflight.** Every operation returns a
body value. Any other status comes from a refusal, and a refusal carries the error envelope of
`../api/README.md`.
```

### Formatting

`lint-staged` runs `prettier --write` over `*.md`. Run it so the committed bytes are stable:

```bash
npx prettier --write docs/proposal/phase-1/transport.md
```

## Constraints

- **Name no library.** The words `koa`, `hono` and `express` must not appear, in any case.
- **Name no source file.** Cite `../api/README.md` and nothing else.
- **Change no existing line.** The `## Browser defences` section at 68-72, the `## Browser access`
  section at 74-86, and `## A held request` at 88-94 stay byte-identical.
- Add no row to the exit-code table at lines 16-24.
- Name no future transport, no migration and no epic number.
- Do not state that an absent body produces `undefined`.
- Do not state a decoding rule the product does not have.

## Verify

```bash
node --test src/http/contract/parity.test.ts src/cli/inventory.test.ts
```

- Both pass unchanged. This story adds no route row and no command.
- `git diff --name-only` names exactly one file: `docs/proposal/phase-1/transport.md`.
- `git diff docs/proposal/phase-1/transport.md` touches no line between 1 and 87, and no line from 88
  onward other than the inserted block.
- This command reports `0`:

```bash
grep -ci "koa\|hono\|express" docs/proposal/phase-1/transport.md
```

- These four commands each report a non-zero count, one per parity group:

```bash
grep -c "An absent request body is an empty object" docs/proposal/phase-1/transport.md
grep -c "The browser headers survive every refusal" docs/proposal/phase-1/transport.md
grep -c "A path segment is never decoded" docs/proposal/phase-1/transport.md
grep -c "An answer carries one of two success statuses" docs/proposal/phase-1/transport.md
```

`npm run verify` exits 0.

Proof: this story delivers the gate bullet **"The proposal section names no framework."** It delivers
no `node --test` line of the Proof block — the gate names no documentation test.
