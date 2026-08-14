# Story 14 — The CLI actor commands, and the file capture

Epic: `.agent/plan/epics/015-actor-identity.md`
Depends on: Story 9 (the contract), Story 12 (a reachable daemon).

## Change

- `src/cli/program.ts:33-51`: add to `ProgramDependencies`

  ```ts
  createSecretFile: (path: string) => SecretFileSink;
  ```

  and export `export type SecretFileSink = Readonly<{ write(text: string): void; discard(): void }>;` from `src/cli/secret-file.ts`, a new file. **The existing `writeFile` at `:39` is not reused**, because it overwrites a path and this one must not.

- `src/main.ts:496-517`: bind `createSecretFile` beside the existing `writeFile` at `:502-505`. The implementation is

  ```ts
  createSecretFile: (path) => ({
    write: (text) =>
      writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" }),
    discard: () => rmSync(path, { force: true }),
  }),
  ```

  `flag: "wx"` makes an existing path fail with `EEXIST`.

- Create `src/cli/actor/register.ts`, `list.ts`, `show.ts`, `revoke.ts` and `rotate.ts`, plus `src/cli/actor/index.ts` holding the `actorCommand(program)` group helper, following the shape of `src/cli/db/index.ts` and `src/cli/db/status.ts`. Register all five in `buildProgram` at `src/cli/program.ts`, after the existing groups.
- `register` takes `--name <name>` and a **required** `--token-file <path>`. `rotate` takes `--id <id>` and a **required** `--token-file <path>`. `list` takes no option. `show` and `revoke` each take `--id <id>`.
- **The register and rotate sequence is contract, in this exact order.**
  1. Build the sink with `createSecretFile(path)`.
  2. **Create the file before issuing the request**, by calling `sink.write("")`. A failed create — an existing path — prints `kanthord: <message>` to stderr, calls `fail()` and returns, **with zero HTTP requests issued**, so a failed create mints no secret.
  3. Issue the one request through `client.call(...)`.
  4. On a failed request, call `sink.discard()` to remove the empty file, print the refusal and `fail()`.
  5. On success, parse the response, call `sink.write(<the token field>)`, and print exactly two lines to stdout: the actor id, then `token: [redacted] -> <path>`.
- **No command prints a token.** A `--print-token` option is refused: one disclosure path is auditable, and two are not.
- `list`, `show` and `revoke` print the view fields and never a token, because the contract response holds none.
- `src/cli/inventory.ts`: add the five entries to `declaredCommands` — `["actor","register"]` → `["actor.register"]`, `["actor","list"]` → `["actor.list"]`, `["actor","show"]` → `["actor.show"]`, `["actor","revoke"]` → `["actor.revoke"]`, `["actor","rotate"]` → `["actor.rotate"]` — in the position the file's existing order implies.

## Constraints

- `src/cli/` imports no command and no query. Every one of the five reaches the daemon over HTTP through the injected `client`.
- `sink.write` is called at most twice per command: once with `""` to create, once with the token. The second call must **not** use `flag: "wx"` semantics against the same path — implement `write` so a second call truncates and rewrites the file it already created. Use `flag: "wx"` on the first write only, by having the sink track whether it has created the path.
- `discard()` is idempotent and never throws for a missing path — hence `force: true`.
- The file mode is `0600` at creation. Do not `chmod` after writing.
- Do not add a `--token-file` option to any other command in this story.

## Verify

- Create `src/cli/secret-file.test.ts` — assert the sink contract against a real `mktemp` directory that the test removes: a first `write` creates the file with mode `0600` (asserted through `statSync(...).mode & 0o777`); a second `write` replaces the content; `write` on a path that already existed **before** the sink was built throws; `discard` removes the file; `discard` on a missing path does not throw.
- Create `src/cli/actor/register.test.ts`, `rotate.test.ts`, `list.test.ts`, `show.test.ts` and `revoke.test.ts`, following the `harness()` convention of `src/cli/repository/register.test.ts:82-127`: a real `Command`, a recording `client.call`, string-accumulating `stdout`/`stderr`, and counters for `fail`/`exit`. Fake `createSecretFile` with a recording sink over an in-memory string.
  - `actor register --name a --token-file <path>` records exactly one call to `actor.register`, writes the returned token to the sink, and **stdout holds the actor id and no token substring** — asserted with `assert.equal(stdoutText().includes(<the token>), false)`.
  - The same two assertions for `actor rotate --id <id> --token-file <path>`.
  - **On an existing path the command fails before it issues a request**: with a sink whose first `write` throws `EEXIST`, assert `calls.length === 0`, `failCalls() === 1`, and that the pre-existing file content is unchanged.
  - **A failed request removes the file the command created**: with a client returning `ok: false`, assert the sink recorded one `discard()` call and that stderr names the refusal.
  - Omitting `--token-file` on `register` and on `rotate` each fail, so the option is genuinely required.
  - `actor list` prints one line per actor including the revoked one, and no line holds a token.
  - `actor show --id <unknown>` prints the daemon refusal and exits non-zero.
- **Write the mode assertion against the real sink, not the fake.** In `src/cli/actor/register.test.ts` add one case that uses the real `createSecretFile` implementation over a `mktemp` path and asserts the resulting file mode is `0600` and its content equals the token. This is the assertion Hermetic coverage line 142 names.
- `src/cli/parity.test.ts` — update every pin this story moves:
  - `:74-80`: `paths.length` 15 → **20**, and the `it(...)` title from `fifteen` to `twenty`.
  - `:112-122`: `calling.length` 12 → **17**, the distinct-id count 17 → **22**, and the title from `seventeen distinct ids across twelve calling entries` to `twenty-two distinct ids across seventeen calling entries`.
  - `:124-138`: the step-only id list at `:131-137` is **unchanged** — each actor command names exactly one operation id, so none contributes a step-only id.
  - `:100-110`: `stubbedPaths` stays `["run"]`; all five actor operations are `routed`.
  - `:82-90`: add `assert.equal(paths.includes("actor"), false)` so the new group command is proved not to be a path.
- Run `node --test --test-timeout=60000 src/cli/secret-file.test.ts src/cli/actor/*.test.ts src/cli/parity.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 142, 143, 144 and 156.
