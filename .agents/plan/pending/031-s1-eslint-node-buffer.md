# EPIC 031 S1 — the `node:buffer` ban under `src/http/server/**`

Ulrich applies this. `scripts/lane-check.sh:47-49` denies every `*.config.*` path to every agent
lane.

**Apply after EPIC 031 story 2 lands, and not before.** Verified against HEAD on 2026-08-23: the
block below fails `npx eslint .` with 5 errors, one per file that still imports `node:buffer` —
`dispatch.ts`, `query.ts`, `single.ts` and `invalid-request.ts` (story 1 clears these), and
`blob/show-blob.ts` (story 2 clears this one).

**Placement.** Insert the block into `eslint.config.js` directly after the
`files: ["src/http/contract/**/*.ts"]` block. It must sit after the generic `files: ["src/**/*.ts"]`
block, because flat config applies the last `no-restricted-imports` entry per file. That is why the
block repeats the `gitLibraries` and `node:child_process` groups instead of adding to them.

```js
  {
    // The transport core imports no node:buffer. The global Buffer survives in
    // idempotency-key.ts and idempotency-store.ts until EPIC 035.
    // src/http/server/koa-body.ts is the one adapter that converts a HandlerResult
    // to a Koa body, and EPIC 032 deletes it. This block repeats the src/**/*.ts
    // restrictions because flat config applies the last no-restricted-imports
    // entry per file.
    files: ["src/http/server/**/*.ts"],
    ignores: ["src/http/server/koa-body.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: ["node:buffer"],
              message:
                "http/server/ is Fetch-native: use TextEncoder and Uint8Array; see docs/proposal/phase-1/transport.md",
            },
            {
              group: gitLibraries,
              message:
                "the git service runs the git binary through spawn; see docs/proposal/phase-1/git-foundation.md",
            },
            {
              group: ["node:child_process"],
              message:
                "only src/services/git/launcher.ts creates a process; see .agents/plan/stories/006-git-primitives/04-supervised-spawn.md",
            },
          ],
        },
      ],
    },
  },
```

**Verify.** `npx eslint .` exits 0, and `npm run verify` is clean.

**Then S2.** EPIC 032 story 16 deletes `src/http/server/koa-body.ts`. Remove
`"src/http/server/koa-body.ts"` from the `ignores` array in the same change. The `node:buffer` group
survives; only the exception goes.
