# Story 15 - The Koa bridge

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 4. Dispatch before Story 5. Coupled with Stories 3 through 16.

## Change

- Add `src/http/server/koa-bridge.ts`.
- Export `const BRIDGE_HOSTNAME = "kanthord.invalid"`.
- Export `koaFromHono(hono: Hono<AppEnv>): Koa` with this exact body:

  ```ts
  export function koaFromHono(hono: Hono<AppEnv>): Koa {
    const listener = getRequestListener(hono.fetch, {
      overrideGlobalObjects: false,
      hostname: BRIDGE_HOSTNAME,
    });
    const app = new Koa();
    app.use(async (context) => {
      context.respond = false;
      await listener(context.req, context.res);
    });
    return app;
  }
  ```

- Import `getRequestListener` from `@hono/node-server`, `Hono` as a type from `hono`, `Koa` as a value, and `AppEnv` as a type.
- Add `src/http/server/koa-bridge.test.ts` with suite name `src/http/server/koa-bridge.test`.
- Build each fixture through `createServer(koaFromHono(hono).callback())`, bind an unref'd server to `127.0.0.1` on port zero, and close it through test cleanup.
- The file must contain exactly six `it` cases:
- Case 1 sends one `%2F` path and one `%zz` path. The Hono wildcard route records `new URL(c.req.url).pathname`; assert the two exact escaped path strings arrive unchanged.
- Case 2 returns `Uint8Array.from([0x00, 0x80, 0xff])`; assert exact body bytes and `content-length: 3`.
- Case 3 returns `new Response(null, { status: 204 })`; assert zero body bytes and absent `content-length` and `content-type`.
- Case 4 sends a POST body containing `{ "a" : 1 }\n`; assert `await c.req.text()` returns the exact whitespace and newline.
- Case 5 save `global.Request` and `global.Response`, call `koaFromHono`, and assert both references remain strictly identical.
- Case 6 sends a raw HTTP/1.0 request without Host. The route records both Host observations and returns `new Response(null, { status: 204 })`.
- Assert `new URL(c.req.url).host === BRIDGE_HOSTNAME`, `c.req.header("host") === undefined`, status 204, and zero body bytes.
- Every ported middleware test still reaches a real socket through `loopbackAgent` or `loopbackServer`, which take a `Koa`.
- Wrap every socket-driven Hono application with `koaFromHono` before passing it to `loopbackAgent` or `loopbackServer`, in `src/http/server/origin.test.ts`, `host.test.ts`, `preflight.test.ts`, `auth.test.ts`, `route.test.ts`, `authorize.test.ts`, `dispatch.test.ts` and `idempotency.test.ts`.
- Stories 5 through 14 own those edits. This story owns only the bridge and its own test.
- Do not convert a socket-driven case to an in-process `hono.request` call. EPIC 033 owns the harness change.

## Constraints

- Keep the bridge branch-free and limited to the four statements in the function body.
- Keep both `overrideGlobalObjects: false` and `hostname: BRIDGE_HOSTNAME`.
- Do not hand-write request conversion, response conversion, content length, or body draining.
- Do not edit `src/http/server/start.ts`, `src/main.ts`, or either shared test helper.
- Use only loopback sockets. Use no wall clock or external network.

## Verify

- Run `node --test src/http/server/koa-bridge.test.ts` after the coupled batch lands.
- The runner reports exactly six passing cases with exact paths, bytes, headers, globals, body text, and fallback authority.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/koa-bridge.test.ts` line.
- Proof: delivers the bridge path, synthetic content-length, global, body-byte, and missing-Host mechanism coverage.
