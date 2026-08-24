# Story 04 — The worker and agent registries

Epic: `.agents/plan/epics/002-domain-and-state-machine.md`
Depends on: nothing. Dispatch it before Story 03 — `src/domain/node.ts`, `src/domain/project.ts`, `src/domain/run.ts` and `src/domain/agent-invocation.ts` import from it.

## Change

### 1. `src/domain/worker.ts` (new)

```ts
import { z } from "zod";

export const workerKinds = ["general@1", "tdd@1", "git@1"] as const;

export const workerKind = z.enum(workerKinds);

export type WorkerKind = z.infer<typeof workerKind>;
```

### 2. `src/domain/agent.ts` (new)

```ts
import { z } from "zod";

export const agentKinds = ["general@1", "swe@1", "te@1", "re@1"] as const;

export const agentKind = z.enum(agentKinds);

export type AgentKind = z.infer<typeof agentKind>;
```

## Constraints

- The order of each array is the order the source states it: `docs/proposal/phase-1/domain.md:10` for the worker kinds, `docs/proposal/phase-1/domain.md:11` for the agent kinds. The agent order also equals the `CHECK` clause of `docs/proposal/database/agent_invocation.md:9`.
- Both sets are closed. No `.catchall`, no `z.string()` fallback, no "unknown" member.
- Neither file carries an implementation, a role contract or a tool set. `docs/proposal/phase-2/agents-and-workers.md:25` puts the tool set in the agent implementation.
- `mr@1` appears in `docs/proposal/phase-1/git-foundation.md:21` and `:135` but is **not** a member of either set. Do not add it.
- Two files, not one. `general@1` is a member of both sets and the two sets are unrelated.

## Verify

`node --test src/domain/worker.test.ts` — new file, suite `"src/domain/worker.test"`:

- `workerKinds` deep-equals `["general@1", "tdd@1", "git@1"]` — exact members, exact order.
- `workerKind.options` deep-equals the same array.
- `workerKind.safeParse("general@1").success` is `true` for each of the three members.
- `workerKind.safeParse(value).success` is `false` for each of `"general"`, `"general@2"`, `"re@1"`, `"mr@1"`, `""`, `"GENERAL@1"`.

`node --test src/domain/agent.test.ts` — new file, suite `"src/domain/agent.test"`:

- `agentKinds` deep-equals `["general@1", "swe@1", "te@1", "re@1"]` — exact members, exact order.
- `agentKind.options` deep-equals the same array.
- Each of the four members parses.
- Each of `"tdd@1"`, `"git@1"`, `"re"`, `"re@2"`, `""` fails to parse.
- Read `docs/proposal/database/agent_invocation.md` with `node:fs` and assert the file contains the literal string `` `CHECK (agent IN ('general@1', 'swe@1', 'te@1', 're@1'))` ``, so a change to the DDL breaks this test rather than drifting silently.

`npm run verify` exits 0.

Proof: contributes `src/domain/worker.test.ts` and `src/domain/agent.test.ts` to `node --test src/domain/**/*.test.ts`.
