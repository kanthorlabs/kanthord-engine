# Story 9 — `agent.list` is routed

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 6

## Change

- Edit `src/http/contract/instruction.ts` lines 5–12. Replace the `agent.list` entry:
  - Change `status: "stubbed"` to `status: "routed"`.
  - Add `response` schema. Export `agentListItem` and `agentListResponse` as named exports from `src/http/contract/instruction.ts`:
    ```ts
    export const agentListItem = z.object({
      agent: z.string(),
      purpose: z.string(),
      capabilities: z.object({ tools: z.array(z.string()) }),
    });
    export const agentListResponse = z.object({
      agents: z.array(agentListItem),
    });
    ```
    Set `response: agentListResponse` on the operation.
  - Add `errors: { ...baselineErrors }` (match adjacent routed entries in `instruction.ts`).
  - Add `examples: [{ id: "re@1-list", request: {}, response: { agents: [{ agent: "re@1", purpose: "Reviews a diff against acceptance criteria.", capabilities: { tools: ["read", "bash", "grep", "find", "ls"] } }] } }]`.

- Add `src/queries/agent/list-agents.ts`. Export:
  - `AgentListItem` type — `z.infer<typeof agentListItem>` imported from `src/http/contract/instruction.ts`.
  - `ListAgentsDependencies` type — `Readonly<Record<string, never>>`.
  - `ListAgentsInput` type — `Readonly<Record<string, never>>`.
  - `listAgents(_dependencies: ListAgentsDependencies, _input: ListAgentsInput): readonly AgentListItem[]` — maps `agentContracts` over `agentKinds` (imported from `src/domain/agent.ts:3`) in tuple order. The return order is: `"general@1"`, `"swe@1"`, `"te@1"`, `"re@1"` — the declaration order of `agentKinds`.

- Add `src/http/server/agent/` directory. Add `src/http/server/agent/list-agents.ts`. Export `listAgentHandler(dependencies: ListAgentHandlerDependencies): Handler`. Dependencies: `{ listAgents: (input: ListAgentsInput) => readonly AgentListItem[] }`. Returns `{ kind: "json", status: 200, body: { agents: results } }`.

- Edit `src/main.ts` in the `handlers` object. Add:

  ```ts
  "agent.list": listAgentHandler({
    listAgents: (input) => listAgents({}, input),
  }),
  ```

  Import `listAgents` from `./queries/agent/list-agents.ts` and `listAgentHandler` from `./http/server/agent/list-agents.ts`.

- Edit `src/http/server/app.test.ts` line 369. Replace `operationId === "agent.list"` with `operationId === "run.start"`. `run.start` is declared in `src/http/contract/execution.ts:179` with `status: "stubbed"` and remains stubbed after this epic. Do not delete the test.

## Constraints

- `listAgents` returns entries in `agentKinds` tuple order: `["general@1", "swe@1", "te@1", "re@1"]`. It does not sort or filter.
- The `agent` field of the response holds the agent id string (not renamed to `id`).
- `listAgents` imports `agentContracts` from `src/domain/agent-contract.ts` and `agentKinds` from `src/domain/agent.ts`.

## Verify

- Add `src/queries/agent/list-agents.test.ts`.
  - Suite name: `"src/queries/agent/list-agents"`.
  - Assert `listAgents({}, {})` deep-equals the exact four-entry array:
    ```
    [
      { agent: "general@1", purpose: "Does any task end to end.", capabilities: { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] } },
      { agent: "swe@1", purpose: "Writes production code. Writes no test.", capabilities: { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] } },
      { agent: "te@1", purpose: "Writes tests. Writes no production code.", capabilities: { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] } },
      { agent: "re@1", purpose: "Reviews a diff against acceptance criteria.", capabilities: { tools: ["read", "bash", "grep", "find", "ls"] } },
    ]
    ```
  - Assert `agentListResponse.parse({ agents: listAgents({}, {}) })` does not throw.
- Add an integration case to `src/http/server/app.test.ts` asserting `GET /v1/agent` with a valid auth token returns `200` and the response body `agents[0].agent === "general@1"` and `agents[3].agent === "re@1"`. Assert the route no longer answers `501`.
- `pnpm run verify` exits 0.
- Run: `node --test src/queries/agent/list-agents.test.ts`
- Proof: `PASS EPIC-048` line `src/queries/agent/list-agents.test.ts`
