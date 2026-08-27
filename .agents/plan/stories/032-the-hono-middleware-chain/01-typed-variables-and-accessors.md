# Story 1 - The typed variables and accessors

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: EPIC 031.

## Change

- Add `src/http/server/variables.ts`.
- Import `Context` from `hono`, `ActorRow` from `src/domain/actor.ts`, `RouteMatch` from `src/http/contract/registry.ts`, `HandlerResult` from `src/http/server/app.ts`, and `StoredAnswer` from `src/http/server/idempotency-response.ts`.
- Write all five as type-only imports. `tsconfig.json:11` sets `verbatimModuleSyntax`, and a value import of `HandlerResult` makes `variables.ts` and `app.ts` a runtime cycle.
- Export this exact variable map:

  ```ts
  export type Variables = {
    headers: Headers;
    match: RouteMatch;
    actor: ActorRow;
    allowedOrigin: string;
    rawBody: string;
    body: unknown;
    result: HandlerResult;
    replay: StoredAnswer;
  };

  export type AppEnv = { Variables: Variables };
  ```

- Keep `OptionalVariable` private and equal to `"allowedOrigin" | "rawBody" | "body" | "result" | "replay"`.
- Export `class VariableError extends Error`.
- Export `demand<Name extends keyof Variables>(c: Context<AppEnv>, name: Name): Variables[Name]`.
- If `c.get(name)` is `undefined`, throw `VariableError` with `the ${name} variable is absent`.
- Otherwise, return the exact stored value.
- Export `optional<Name extends OptionalVariable>(c: Context<AppEnv>, name: Name): Variables[Name] | undefined` and return the runtime getter value unchanged.
- Add `src/http/server/variables.test.ts` with suite name `src/http/server/variables.test`.
- Construct empty `Context<AppEnv>` instances from Fetch `Request` values.
- Add a table for `headers`, `match`, and `actor`. Assert that each absent demand throws `VariableError` with its exact variable-specific message.
- Set a `headers` value and assert that `demand` returns the same object by identity.
- Assert that `optional(c, "body")` returns `undefined` before a write and returns the exact written value after a write.

## Constraints

- Do not export `OptionalVariable` or `RouteMatch`.
- Treat only runtime `undefined` as absence.
- Use explicit `.ts` extensions for local imports.
- Do not edit any existing production or test file.

## Verify

- Run `node --test src/http/server/variables.test.ts`.
- The three absent-variable rows throw the exact class and messages. Present values preserve identity.
- `npm run verify` exits 0.
- Proof: delivers the `src/http/server/variables.test.ts` line.
- Proof: delivers "An accessor throws when a variable is absent."
