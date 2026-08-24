# Story 1 — The proposal records the wait

Epic: `.agents/plan/epics/028-event-long-poll.md`
Depends on: Story 2, Story 3.

Documentation only. No file under `src/`, `test/` or `scripts/` changes.

## Change

### `docs/proposal/api/event.md`

**Edit 1.** Replace line 24 in full. Line 24 today reads:

```
`wait` is the sixth parameter, and it turns the same operation into a long poll. It is the decided progress channel for a GUI client, and `event.stream` below states why the stream is not. **`wait` is phase-2.** The cursor ships in phase 1 and answers the same question with a client-side timer; the long poll needs the daemon to hold a request open and to wake on an append, which is a transport capability rather than a parameter. A phase-1 daemon rejects `wait` with `400 invalid-request`, because the request schema declares no such field.
```

Replace that one line with these four paragraphs, separated by one blank line each:

```
`wait` is the sixth parameter, in seconds, and it turns the same operation into a long poll. The daemon holds the request until an event matching the filters arrives or the wait elapses, then answers with the ordinary response shape. It is the decided progress channel for a GUI client, and `event.stream` below states why the stream is not.

**An elapsed wait is a normal `200` with an empty array.** It is never `204`, never `408` and never an error envelope. A client must be able to tell a quiet daemon from an unreachable one, and the status class is the only signal it has before it parses anything.

**An absent `wait` and `wait=0` both answer at once, and a first read that returns events never waits.** A catch-up client is therefore as fast as it was before the parameter existed, and every client written against the cursor alone keeps its exact behaviour.

**The bound is refused, never clamped.** The request schema caps `wait` at 60 seconds, and the daemon caps it again at `http.event.maxWait`, which defaults to 30. A `wait` above either bound answers `400 invalid-request`, because a client that asks for five minutes has a wrong idea of the contract and should be told. A browser tab holds one connection for the duration, so any browser, proxy or NAT idle timeout on the path must be longer than the configured maximum.
```

**Edit 2.** Replace line 40 in full. Line 40 today begins `event.list` therefore gains one optional query parameter, `wait`, bounded in seconds, **in phase 2**. and states the elapsed-wait rule in the future tense. Replace that one line with:

```
`event.list` carries one optional query parameter, `wait`, bounded in seconds, and the section above states it. One outstanding request replaces a poll loop, and it needs no new media type, no new transport and no resume semantics.
```

**Edit 3.** Replace line 42 in full. Line 42 today begins **Through phase 1 a client polls the cursor on its own timer.** Replace that one line with:

```
**A client that cannot hold a request open still polls the cursor on its own timer.** That is the same mechanism with the wait on the client side, so no client code was thrown away when `wait` arrived: the request gained one parameter and the poll interval went away.
```

**Edit 4.** Replace line 44 in full. Line 44 today reads `Keep the bound conservative. A browser tab holds one connection for the duration of the wait, and any browser, proxy or NAT idle timeout on the path must be longer than it.` Replace that one line with:

```
The bound is conservative for that reason, and `../phase-1/transport.md` states what a held request costs the daemon lifecycle.
```

Change no other line. Do not touch the route table at lines 9-13. Leave lines 18, 20 and 22 — the cursor, the order and the range paragraphs — byte-identical.

### `docs/proposal/phase-1/transport.md`

Add one new section, `## A held request`, immediately before `## Every request carries its own payload` at line 52. The file has no shutdown section today, so this is the section that introduces one:

```
## A held request

One route holds a connection open: `GET /v1/event` with `wait`, and `../api/event.md` states the parameter. Nothing else in the product holds a request.

**A shutdown ends every held request at once, and the daemon does not wait for the waiters.** The signal cancels every outstanding wait before it closes the listener, and each cancelled wait answers as a normal empty `200`. So a client sees a quiet daemon and reconnects, rather than seeing a dropped socket, and a stop takes no longer than it took before the parameter existed. Closing the listener first would have made every shutdown last as long as the longest outstanding wait.

**An operator behind a reverse proxy sets the proxy read timeout above `http.event.maxWait`.** Nothing enforces that. A misconfigured proxy shows up as a periodic disconnect the client cannot distinguish from a network fault.
```

Change no other line in the file.

### Formatting

`lint-staged` runs `prettier --write` over `*.md`. Run it on both files so the committed bytes are stable:

```bash
npx prettier --write docs/proposal/api/event.md docs/proposal/phase-1/transport.md
```

## Constraints

- The route matrix in `docs/proposal/api/event.md` is unchanged. `src/http/contract/parity.test.ts:25` asserts 74 proposal rows and that count must not move.
- `event.stream` stays `post-mvp` and `deferred`. Add no route, no operation id and no status change.
- Say nothing about a notification, a post-commit hook or a stream. The wait polls, and the upgrade path is not decided here.
- Say nothing about a harness reading the wait. `event.list` admits `human` only, and that is an open authorization question.
- Amend no other proposal file. In particular leave `docs/proposal/after-the-mvp.md` and `docs/proposal/api/README.md` untouched — `README.md:54` says every phase-1 route answers with data, and that stays true.
- Two numbers appear and they are different: the schema ceiling is 60 and the configured default is 30. Do not collapse them into one.

## Verify

The baseline comes from `HEAD`, so it needs no capture step and cannot be taken in the wrong order:

```bash
node --test src/http/contract/parity.test.ts
```

- `parity.test.ts` passes, and the row count assertion at line 25 still reads `74`.
- `git diff --stat docs/` names exactly two files, `docs/proposal/api/event.md` and `docs/proposal/phase-1/transport.md`.
- `git diff docs/proposal/api/event.md` touches no line inside the table at lines 9-13, and no line among 18, 20 and 22.
- The string `phase-2` does not appear in `docs/proposal/api/event.md` after the edit. Check with `grep -c "phase-2" docs/proposal/api/event.md` and expect `0`.

`npm run verify` exits 0.

Proof: no `PASS EPIC-028` line is attributable to this story — the Proof block names no documentation test. The epic is complete only when this story has landed, because the Goal's contract is stated in `docs/proposal/`, which `AGENTS.md` names the source of truth for behaviour.
