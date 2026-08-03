# Story 09 — Staged `npm run verify`

Epic: `.agent/plan/epics/001-runtime-foundation.md`
Depends on: nothing in this epic. Land it last, so that the gate every earlier story ran is the gate this story leaves behind.

## Change

**`package.json:12`** — remove the last step of `verify`. Replace

```json
"verify": "npm run typecheck && npm test && npm run lint && node src/main.ts db status"
```

with

```json
"verify": "npm run typecheck && npm test && npm run lint"
```

Change nothing else in `package.json`. Story 02 owns `bin`.

`docs/proposal/api/system.md:34` makes `db status` an HTTP client command against a running daemon. No daemon listens until EPIC 004, and no `db` command exists until EPIC 003, so the step cannot pass at the epic it gates. EPIC 009 restores it as a step that migrates a temporary home, starts a daemon on a loopback port, calls `db status`, stops the daemon and removes the home.

## Constraints

- Do not add a substitute step. `verify` is `typecheck`, `test`, `lint`, in that order, and nothing else.
- Do not touch `"test": "node --test"`. It discovers every `*.test.ts` under the repository, which is what every story's Proof relies on.

## Verify

- `npm run verify` exits 0 from a clean tree.
- `git diff package.json` touches the `verify` line only.
- `npm run verify` fails when a test fails, checked once by hand: break one assertion, confirm a non-zero exit, restore it.

Proof: this story delivers the epic `Gates:` line, `npm run verify`. It delivers no `PASS` marker of its own.
