# Story 11 — The handlers route the three operations

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 7 (the commands), Story 10 (the contract declares the operations).

A handler parses, calls exactly one command, and formats. It branches on no domain rule.

## Change

### `src/http/server/credential/start-provider-login.ts` (new file)

Follow `src/http/server/credential/register-provider.ts:1-37` exactly — it is the
body-taking precedent.

```ts
export type StartProviderLoginHandlerDependencies = Readonly<{
  startProviderLogin: (
    input: StartProviderLoginInput,
  ) => Promise<StartProviderLoginResult>;
}>;

export function startProviderLoginHandler(
  dependencies: StartProviderLoginHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = providerLoginStartRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the provider login body is invalid",
        parsed.error,
      );
    }
    try {
      const result = await dependencies.startProviderLogin({
        provider: parsed.data.provider,
        answers: parsed.data.answers ?? {},
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
```

`answers` defaults to `{}` here, so the command never sees `undefined`.

### `src/http/server/credential/complete-provider-login.ts` (new file)

The same shape over `providerLoginCompleteRequest` and `completeProviderLogin`. Pass `code`
through only when present:
`{ loginId: parsed.data.loginId, ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }) }`.
The distinction between an absent and a supplied `code` is load-bearing on the manual arm,
so the handler must not substitute `""`.

### `src/http/server/credential/cancel-provider-login.ts` (new file)

The same shape over `providerLoginCancelRequest` and `cancelProviderLogin`, returning a
body-less 204:

```ts
await dependencies.cancelProviderLogin({ loginId: parsed.data.loginId });
return { kind: "empty", status: 204 };
```

`EmptyResult` already exists — `src/http/server/app.ts:59-60` declares
`{ kind: "empty"; … }` and `HandlerResult` at `:65` admits it. Use it as written. **Do not
edit `src/http/server/app.ts`**; no new response path is needed. This is still the first
204 in the contract — see blocker **B4** in the index.

### `src/http/server/credential/refusals.ts`

Extend `toHttpError` (`src/http/server/credential/refusals.ts:10-64`) with three branches,
inserted before the final `throw error` at `:63`. Follow the `VerifyProviderError` branch
at `:52-62`: special-case the codes that are not `invalid-request`, then fall through.

```ts
if (error instanceof StartProviderLoginError) {
  return httpError("invalid-request", error.message, {
    refusal: error.refusal,
    detail: error.detail,
  });
}
if (error instanceof CompleteProviderLoginError) {
  if (error.refusal === "not-found") {
    return httpError("not-found", error.message);
  }
  return httpError("invalid-request", error.message, {
    refusal: error.refusal,
  });
}
if (error instanceof CancelProviderLoginError) {
  return httpError("not-found", error.message);
}
```

`CancelProviderLoginError` has one refusal, `not-found`, so its branch needs no test on
`error.refusal`. `StartProviderLoginError` carries `detail`, which is how
`login-input-required` delivers the exact prompt message to the dashboard.

Import the three classes from `../../../commands/provider/*.ts`.

### `src/main.ts`

1. Add the three command imports beside the existing provider imports, and the three
   handler imports beside the existing handler imports.
2. In the `handlers` object, insert the three entries after `"provider.list"`
   (`src/main.ts:411-413`) and before `"provider.register"` (`:393`) — position in the
   object literal is free, but keep them together and alphabetical for readability:

   ```ts
   "provider.loginStart": startProviderLoginHandler({
     startProviderLogin: (input) =>
       startProviderLogin(
         { storage, providerAuth, ids, clock, instanceId },
         input,
       ),
   }),
   "provider.loginComplete": completeProviderLoginHandler({
     completeProviderLogin: (input) =>
       completeProviderLogin(
         { storage, providerAuth, crypto, catalog, clock, instanceId },
         input,
       ),
   }),
   "provider.loginCancel": cancelProviderLoginHandler({
     cancelProviderLogin: (input) =>
       cancelProviderLogin({ storage, providerAuth }, input),
   }),
   ```

   `instanceId` is in scope from `src/main.ts:209`. `catalog` is at `:358`, `providerAuth`
   at `:359`, `crypto` at `:353`, `clock` at `:228`, `ids` at `:247`, `storage` at `:229`.

### `src/main.test.ts`

The fixture map must equal the routed set exactly (`src/main.test.ts:270-281`), so all
three need an entry. Insert after `"provider.list"` (`:72`):

```ts
"provider.loginCancel": {
  body: { loginId: missing("login") },
  expect: 404,
},
"provider.loginComplete": {
  body: { loginId: missing("login") },
  expect: 404,
},
"provider.loginStart": {
  body: { provider: "openai-compatible" },
  expect: 400,
},
```

`missing("login")` builds `login_01JZZZZZZZZZZZZZZZZZZZZZZZ` from the helper at
`src/main.test.ts:28-30`; the prefix is the one Story 3 registers. Cancel and complete both
answer `404` for a login that never existed. `loginStart` names `openai-compatible`, which
carries no oauth flow, so the real daemon refuses `provider-not-oauth-capable` as a `400`
with zero outbound calls — the fixture therefore reaches no vendor.

### Tests

**`src/http/server/credential/start-provider-login.test.ts` (new file)**, following
`src/http/server/credential/verify-provider.test.ts` exactly:

1. `it("POST /v1/provider/login answers 200 with the device challenge and passes the parsed body")` —
   assert the status, the body deep-equal to the fixture result, and that the command
   received `{ provider: "openai-codex", answers: {} }`.
2. `it("passes the answers map through unchanged")` — a body with
   `answers: { "GitHub Enterprise URL/domain (blank for github.com)": "" }`; assert the
   command received exactly that map.
3. `it("refuses an invalid body with 400 before calling the command")`.
4. `it("maps login-in-progress to 400 invalid-request with the refusal")`.
5. `it("maps login-input-required to 400 and carries the prompt message in details.detail")` —
   assert `response.body.error.details.detail` equals the exact message string.
6. `it("maps provider-not-oauth-capable to 400")`.

**`src/http/server/credential/complete-provider-login.test.ts` (new file)**:

7. `it("POST /v1/provider/login/complete answers 200 with the models")`.
8. `it("omits code when the body omits it")` — assert the command received an input with no
   `code` key, by `assert.equal("code" in received, false)`.
9. `it("passes the exact code when the body carries it")`.
10. `it("maps not-found to 404")`.
11. `it("maps login-pending to 400 invalid-request with the refusal")`.
12. `it("maps code-not-accepted, code-required, login-expired and login-lost to 400")` —
    one assertion per refusal, each checking `error.details.refusal`.

**`src/http/server/credential/cancel-provider-login.test.ts` (new file)**:

13. `it("POST /v1/provider/login/cancel answers 204 with no body")` — assert
    `response.status === 204` and that the response body is empty.
14. `it("passes the parsed loginId")`.
15. `it("maps not-found to 404")`.
16. `it("refuses an invalid body with 400")`.

**`src/http/server/credential/refusals.test.ts`** — add one case per class, following the
existing form:

17. `it("StartProviderLoginError → invalid-request carrying refusal and detail")`.
18. `it("CompleteProviderLoginError not-found → not-found")`.
19. `it("CompleteProviderLoginError login-pending → invalid-request")`.
20. `it("CancelProviderLoginError → not-found")`.

Use `result.code`, not `result.kind` — `HttpError` exposes `code`
(`src/http/contract/errors.ts:81-93`).

## Constraints

- No handler branches on a refusal. Every refusal reaches `toHttpError` untouched.
- No handler reads storage, calls a service, or catches an error other than to re-throw it
  through `toHttpError`.
- The complete handler never substitutes a value for an absent `code`.
- The three operations appear in `src/main.test.ts` fixtures, or two tests there fail.
- The `provider.loginStart` fixture names a vendor with no oauth flow, so the daemon test
  performs no outbound call.
- Nothing in this story logs a request body, a code or a response body.

## Verify

```
node --test \
  src/http/server/credential/start-provider-login.test.ts \
  src/http/server/credential/complete-provider-login.test.ts \
  src/http/server/credential/cancel-provider-login.test.ts \
  src/http/server/credential/refusals.test.ts \
  src/main.test.ts
npm run verify
```

Asserts: each route's success status and body, the parsed input reaching the command
verbatim including the absent-`code` case, `details.detail` carrying the exact prompt
message, every refusal mapped to its status, the 204 with no body, and the real daemon
answering all three routes without falling through to the shared 501.

Proof: delivers `src/http/server/credential/start-provider-login.test.ts`,
`src/http/server/credential/complete-provider-login.test.ts`,
`src/http/server/credential/cancel-provider-login.test.ts` and `src/main.test.ts`
(PASS EPIC-045). `npm run verify` exits 0.
