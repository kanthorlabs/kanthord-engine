# Story 6 — The agent role contracts

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`

## Change

- Add `src/domain/agent-contract.ts`. Export:
  - `tools: readonly ["read", "bash", "edit", "write", "grep", "find", "ls"]` — a `const` tuple in this exact order.
  - `AgentContract` type — `Readonly<{ agent: string; purpose: string; capabilities: { tools: readonly string[] } }>`.
  - `agentContracts: Readonly<Record<string, AgentContract>>` — one entry per element of `agentKinds` (imported from `src/domain/agent.ts:3`), keyed by agent id. The four entries are:

    `"general@1"`: `{ agent: "general@1", purpose: "Does any task end to end.", capabilities: { tools } }`
    `"swe@1"`: `{ agent: "swe@1", purpose: "Writes production code. Writes no test.", capabilities: { tools } }`
    `"te@1"`: `{ agent: "te@1", purpose: "Writes tests. Writes no production code.", capabilities: { tools } }`
    `"re@1"`: `{ agent: "re@1", purpose: "Reviews a diff against acceptance criteria.", capabilities: { tools: ["read", "bash", "grep", "find", "ls"] as const } }`

  `general@1`, `swe@1` and `te@1` reference the shared `tools` constant. `re@1` declares its own inline `const` tuple `["read", "bash", "grep", "find", "ls"]`.

## Constraints

- No entry in `agentContracts` carries a `paths` field. The absence is the record of the stated gap (role path ownership is not represented).
- No entry in `agentContracts` references a `workerRegistry` entry. The contracts are independent of the registry.
- This file imports `agentKinds` from `./agent.ts` only to enforce completeness in the TypeScript type (use `satisfies Readonly<Record<(typeof agentKinds)[number], AgentContract>>`). It does not import from `./worker-registry.ts`.

## Verify

- Add `src/domain/agent-contract.test.ts`.
- Suite name: `"src/domain/agent-contract"`.
- Assert `tools` deep-equals `["read", "bash", "edit", "write", "grep", "find", "ls"]`.
- Assert `agentContracts["re@1"].capabilities.tools` deep-equals `["read", "bash", "grep", "find", "ls"]`.
- Assert `!agentContracts["re@1"].capabilities.tools.includes("edit")` is true.
- Assert `!agentContracts["re@1"].capabilities.tools.includes("write")` is true.
- Assert `agentContracts["swe@1"].capabilities.tools` deep-equals `agentContracts["te@1"].capabilities.tools`.
- Assert `agentContracts["general@1"].capabilities.tools` deep-equals `agentContracts["swe@1"].capabilities.tools`.
- Assert that no entry in `agentContracts` has a `"paths"` key: `Object.values(agentContracts).every(c => !("paths" in c))` is true.
- Run: `node --test src/domain/agent-contract.test.ts`
- Proof: `PASS EPIC-048` line `src/domain/agent-contract.test.ts`
