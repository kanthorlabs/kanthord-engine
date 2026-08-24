# Story 4 — the register handler is untouched

Epic: `.agents/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 2.

## Change

- `src/http/server/credential/register-provider.ts` changes in no way. Lines 16-22 keep the detail-less `httpError("invalid-request", "the provider registration body is invalid")`. Add no inspection of `parsed.error`, no read of an issue path and no `refusal` argument.
- The only edits of this story are the two tests named in Verify, added to `src/http/server/credential/register-provider.test.ts`.

## Constraints

- A handler that reads a zod issue to choose a domain refusal fails review. AGENTS.md admits only parse, invoke and format in a handler.
- Add no shared `ZodError` formatter under `src/http/server/`. That is a non-goal of this epic.
- Change `toHttpError` in `src/http/server/credential/refusals.ts` in no way in this story. Its `PayloadError` branch at lines 9-14 already carries `refusal` and `detail`, and that is the channel the command's refusals use.
- Change `src/commands/provider/register-provider.ts` in no way. It still calls `parsePayload`.

## Verify

- Add to `src/http/server/credential/register-provider.test.ts` a test named `"a git payload naming password is a detail-less invalid-request"`. Build the app with `createTestApp` and a `registerProvider` stub that records whether it was called. `POST /v1/provider` with `{ name: "github", kind: "git", payload: { transport: "http-basic", forge: "github", username: "atlas", password: "x" } }` answers `400`; `response.body.error.code === "invalid-request"`; `Object.hasOwn(response.body.error, "details") === false`; the stub was not called; and `app.internalErrors().length === 0`.
- Add a test named `"an encrypted private key still reaches the client as a command refusal"`. The `registerProvider` stub throws `new PayloadError("private-key-encrypted", "<the message the command builds>", "aes256-ctr")`. `POST /v1/provider` with a well-formed `git` `ssh` payload carrying the real passphrase-protected key fixture answers `400`, `response.body.error.details.refusal === "private-key-encrypted"` and `response.body.error.details.detail === "aes256-ctr"`. The payload must satisfy `providerRegisterRequest`, so the stub is reached; a shape failure would make this test assert the wrong branch. Assert additionally that the stub **was** called, so a future schema tightening that swallows the key cannot make this test pass vacuously.
- The handler test above proves the HTTP mapping only, because these handler tests stub the command by house convention. The other half is the command's own proof: strengthen the existing encrypted-key case at `src/commands/provider/register-provider.test.ts:577-600` to assert not only `refusal === "private-key-encrypted"` but also `error.detail === "aes256-ctr"`, using the same key fixture. The two together deliver the EPIC's Hermetic bullet 7; neither does alone. Use the same fixture key in both, so the `aes256-ctr` value is one fact asserted twice rather than two independent guesses.
- Confirm the handler file is byte-identical to its committed version: `git diff --exit-code src/http/server/credential/register-provider.ts` exits 0.
- Run `node --test --test-timeout=60000 src/http/server/credential/register-provider.test.ts`; it exits 0.
- Run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/http/server/credential/*.test.ts`, plus Hermetic coverage "The payload contract" bullets 6 and 7.
