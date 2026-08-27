# Story 5 — The proposal states the transport structure

Epic: `.agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md`
Depends on: Story 1, for the directory names, and Story 3, for the test name.

## Change

Amend `docs/proposal/phase-1/transport.md`. Insert one new section after line 10 and before the blank line that precedes `## The CLI exit code names the refusal class` at `:12`. Change no other line of the file, and no other file.

The inserted text is the following, with one blank line before it and one blank line after it. Then run `npx prettier --write docs/proposal/phase-1/transport.md` and commit that output: `prettier` realigns a markdown table to its longest cell, so the committed bytes of the table differ from the bytes quoted here. The wording is normative; the table alignment is not.

```markdown
## The transport core and its runtime roots

The transport splits in two. `src/http/server/**`, except `src/http/server/runtime/**`, is the Fetch-native core. No file in the core imports a `node:` builtin. The core uses Web APIs only: `Request`, `Response`, `Headers`, `TextEncoder`, `Uint8Array` and `crypto.subtle`.

Each runtime gets its own root, and only a root names a platform API. The core declares a type or an interface, and a root supplies the implementation, so a bundler cannot traverse a Node-only module from the core.

| Root                              | State                                                |
| --------------------------------- | ---------------------------------------------------- |
| `src/http/server/runtime/node/`   | built. It holds the listener and the timer schedule. |
| `src/http/server/runtime/lambda/` | declared, and not built.                             |
| `src/http/server/runtime/worker/` | declared, and not built.                             |

`src/http/server/core-purity.test.ts` enforces the invariant. It reads every `.ts` file under `src/http/server/`, skips `runtime/` and skips a test, and it fails on a `node:` import. The failure names the file and the specifier.
```

`src/http/server/node/` holds the handlers of the `node` domain entity, so the runtime directory takes the name `runtime` and the collision cannot happen.

## Constraints

- Documentation only. Change no `.ts` file and no `.js` file.
- Do not edit `AGENTS.md`. The `http/server/**` line and the enforcement-table row are S3 of the EPIC, and the human applies them.
- Do not rename an existing heading in `transport.md`, and do not reorder an existing section.
- Do not describe a Lambda handler or a Worker export as existing. EPIC 036 decides whether either gets built.

## Verify

- `npm run verify` exits 0. Assert no byte-for-byte equality against the quoted table; `prettier` owns its alignment. `npm test` passes: no test reads `docs/proposal/phase-1/transport.md`.
- `git diff` on `docs/proposal/phase-1/transport.md` shows one added section and no other change. A `prettier` reflow of an untouched paragraph elsewhere in the file is a defect; report it rather than commit it.
- `grep -n "^## " docs/proposal/phase-1/transport.md` lists `## The transport core and its runtime roots` between `## HTTP is the surface, the CLI calls it` and `## The CLI exit code names the refusal class`.
- `grep -n "core-purity.test.ts" docs/proposal/phase-1/transport.md` matches one line.
- `git diff --stat` names `docs/proposal/phase-1/transport.md` and nothing else.
- Proof: no Proof line. This story carries the `docs/proposal/` half of the epic, which `AGENTS.md` names the source of truth for behaviour.
