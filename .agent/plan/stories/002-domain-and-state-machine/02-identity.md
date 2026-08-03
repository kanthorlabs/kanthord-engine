# Story 02 — Identity

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`

## Change

### `src/domain/identity.ts` (new)

```ts
import { z } from "zod";

export const identityKinds = [
  "provider",
  "project",
  "repository",
  "profile",
  "initiative",
  "objective",
  "task",
  "edge",
  "planRevision",
  "workspace",
  "run",
  "attempt",
  "agentInvocation",
  "candidate",
  "checkResult",
  "gitOperation",
  "event",
] as const;

export type IdentityKind = (typeof identityKinds)[number];

export const identityPrefixes: Readonly<Record<IdentityKind, string>> = {
  provider: "provider",
  project: "project",
  repository: "repo",
  profile: "profile",
  initiative: "initiative",
  objective: "objective",
  task: "task",
  edge: "edge",
  planRevision: "revision",
  workspace: "workspace",
  run: "run",
  attempt: "attempt",
  agentInvocation: "invocation",
  candidate: "candidate",
  checkResult: "check",
  gitOperation: "gitop",
  event: "event",
};

export const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export type Identity = Readonly<{
  kind: IdentityKind;
  prefix: string;
  ulid: string;
}>;

export type IdentityErrorCode = "identity-kind-mismatch";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

export function parseIdentity(value: string): Identity | null;

export function assertIdentity(value: string, kind: IdentityKind): Identity;

export function identity(kind: IdentityKind): z.ZodType<string>;

export const anyIdentity: z.ZodType<string>;

export const nodeIdentity: z.ZodType<string>;
```

Exact behaviour of each export:

- `identityPrefixes` — the 17 prefixes of `docs/proposal/database/README.md:51-67`. `repository` maps to `repo`, `planRevision` to `revision`, `agentInvocation` to `invocation`, `checkResult` to `check`, `gitOperation` to `gitop`. Every other kind maps to its own name.
- `parseIdentity(value)` — splits on the **first** `_`. Returns `null` when there is no `_`, when the prefix matches no entry of `identityPrefixes`, or when the remainder does not match `ulidPattern`. Otherwise returns `{ kind, prefix, ulid }` where `kind` is the key whose prefix equals the parsed prefix.
- `assertIdentity(value, kind)` — calls `parseIdentity`. Throws `IdentityError("identity-kind-mismatch", ...)` when the result is `null` or when `result.kind !== kind`. The message is `` `${value} is not a ${kind} identity` ``. Returns the `Identity` otherwise.
- `identity(kind)` — a memoised `z.string()` schema that passes only when `parseIdentity(value)?.kind === kind`. The refine message is `` `expected a ${identityPrefixes[kind]}_ identity` ``. Memoised means one schema object per kind, held in a module-level `Map`, so two calls with the same kind return the same reference.
- `anyIdentity` — a `z.string()` schema that passes when `parseIdentity(value) !== null`. Message `"expected a prefixed ULID identity"`.
- `nodeIdentity` — a `z.string()` schema that passes when the parsed kind is one of `initiative`, `objective`, `task`. Message `"expected an initiative_, objective_ or task_ identity"`.

## Constraints

- `zod` is the only import. `docs/proposal/phase-1/domain.md` and `eslint.config.js:172-189` make `src/domain/` pure.
- The ULID alphabet is Crockford base32 uppercase. `I`, `L`, `O` and `U` are excluded; `ulidPattern` already encodes that.
- The first character is bounded to `0-7`. A ULID is 128 bits in 26 Crockford characters, so the leading character carries 3 significant bits and a value above `7` overflows. A pattern of 26 free characters would accept a string no generator can produce.
- No mint function here. Minting is `src/services/ids/ulid.ts` (Story 01).
- Three kinds map onto one table (`initiative`, `objective`, `task` → `node`), per `docs/proposal/database/README.md:71`. Do not collapse them.
- `blob`, `migration` and `project_binding` mint no identity (`docs/proposal/database/README.md:69`), so they appear in no list here.

## Verify

`node --test src/domain/identity.test.ts` — new file, one suite named `"src/domain/identity.test"`:

- `identityKinds.length` equals `17`, and `Object.keys(identityPrefixes).length` equals `17`.
- `new Set(Object.values(identityPrefixes)).size` equals `17` — no two kinds share a prefix.
- A table-driven loop over all 17 kinds: `parseIdentity(\`${identityPrefixes[kind]}_01HZY8QF3M4N5P6R7S8T9V0W1X\`)`deep-equals`{ kind, prefix: identityPrefixes[kind], ulid: "01HZY8QF3M4N5P6R7S8T9V0W1X" }`.
- The five renamed prefixes are asserted individually as exact strings: `identityPrefixes.repository === "repo"`, `.planRevision === "revision"`, `.agentInvocation === "invocation"`, `.checkResult === "check"`, `.gitOperation === "gitop"`.
- `parseIdentity` returns `null` for each of: `""`, `"01HZY8QF3M4N5P6R7S8T9V0W1X"` (no prefix), `"widget_01HZY8QF3M4N5P6R7S8T9V0W1X"` (unknown prefix), `"project_"` (empty ulid), `"project_01hzy8qf3m4n5p6r7s8t9v0w1x"` (lowercase), `"project_01HZY8QF3M4N5P6R7S8T9V0W1"` (25 chars), `"project_01HZY8QF3M4N5P6R7S8T9V0W1XX"` (27 chars), `"project_01HZY8QF3M4N5P6R7S8T9V0WIX"` (contains `I`), `"project_01HZY8QF3M4N5P6R7S8T9V0WLX"` (`L`), `"project_01HZY8QF3M4N5P6R7S8T9V0WOX"` (`O`), `"project_01HZY8QF3M4N5P6R7S8T9V0WUX"` (`U`), `"project_81HZY8QF3M4N5P6R7S8T9V0W1X"` (leading `8` overflows 128 bits), `"project_Z1HZY8QF3M4N5P6R7S8T9V0W1X"` (leading `Z`).
- `parseIdentity("gitop_01HZY8QF3M4N5P6R7S8T9V0W1X")?.kind` equals `"gitOperation"` — the split is on the first `_` only, and an underscore inside a prefix name does not exist.
- `assertIdentity("task_01HZY8QF3M4N5P6R7S8T9V0W1X", "task")` returns an `Identity` with `kind === "task"`.
- `assertIdentity("task_01HZY8QF3M4N5P6R7S8T9V0W1X", "objective")` throws, and the thrown error satisfies `error instanceof IdentityError`, `error.code === "identity-kind-mismatch"` and `error.message === "task_01HZY8QF3M4N5P6R7S8T9V0W1X is not a objective identity"`.
- `assertIdentity("nonsense", "task")` throws with the same code.
- `identity("project").safeParse("project_01HZY8QF3M4N5P6R7S8T9V0W1X").success` is `true`; `identity("project").safeParse("repo_01HZY8QF3M4N5P6R7S8T9V0W1X").success` is `false`.
- `identity("project")` returns the identical object reference on a second call (`assert.equal(identity("project"), identity("project"))`).
- `nodeIdentity` accepts the three node prefixes and rejects `repo_01HZY8QF3M4N5P6R7S8T9V0W1X`.
- `anyIdentity` accepts one identity of every one of the 17 kinds and rejects `"widget_01HZY8QF3M4N5P6R7S8T9V0W1X"`.

`npm run verify` exits 0.

Proof: contributes `src/domain/identity.test.ts` to `node --test src/domain/**/*.test.ts`.
