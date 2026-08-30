# Story 7 — The harness set and the contract generator

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 6

## Change

- Add `src/domain/harness.ts`. Export:
  - `HarnessDescriptor` type — `Readonly<{ id: string; denyByDefault: boolean }>`.
  - `harnesses: readonly [HarnessDescriptor, HarnessDescriptor, HarnessDescriptor]` — a `const` tuple with these three entries in this order:
    1. `{ id: "claude-code", denyByDefault: true }`
    2. `{ id: "opencode", denyByDefault: true }`
    3. `{ id: "pi", denyByDefault: false }`

- Add `src/domain/agent-contract-render.ts`. Export:
  - `AgentContractErrorCode` type — `"harness-unknown" | "harness-cannot-deny"`.
  - `AgentContractError extends Error` with `readonly code: AgentContractErrorCode`. Constructor: `(code: AgentContractErrorCode, message: string)`.
  - `renderAgentContract(contract: AgentContract, harnessId: string): string` — looks up `harnessId` in `harnesses`. Throws `AgentContractError("harness-unknown", ...)` if the id is not found. Throws `AgentContractError("harness-cannot-deny", ...)` if `descriptor.denyByDefault` is false. Returns the rendered document string.

  The rendered format for both `claude-code` and `opencode` is a markdown file with YAML frontmatter:

  ```
  ---
  name: <contract.agent>
  description: <contract.purpose>
  tools: <tools-list>
  ---
  ```

  Where `<tools-list>` is the tools array joined with `,` and each name mapped to its capitalized form: `read→Read`, `bash→Bash`, `edit→Edit`, `write→Write`, `grep→Grep`, `find→Find`, `ls→LS`. The order follows the contract's `capabilities.tools` array. No body content follows the closing `---`. The file ends with a single newline after the closing `---`.

  Example for `re@1` on `claude-code`:

  ```
  ---
  name: re@1
  description: Reviews a diff against acceptance criteria.
  tools: Read,Bash,Grep,Find,LS
  ---
  ```

  `harness.ts` is the only file that holds the descriptor lookup. `renderAgentContract` reads the descriptor from the `harnesses` tuple; it does not accept a descriptor from the caller.

- Create `test/fixtures/agent-contract/` (this directory does not exist yet — greenfield). Commit eight golden fixture files, one per agent per deny-by-default harness. Filenames: `test/fixtures/agent-contract/claude-code/general@1.md`, `…/swe@1.md`, `…/te@1.md`, `…/re@1.md`, and `test/fixtures/agent-contract/opencode/general@1.md`, `…/swe@1.md`, `…/te@1.md`, `…/re@1.md`. Generate each by running `renderAgentContract(agentContracts[agentId], harnessId)` once, then write the output verbatim as the fixture file. Do not hand-author fixture content.

## Constraints

- The `harnesses` tuple order is fixed: `claude-code` at index 0, `opencode` at index 1, `pi` at index 2. The order is the lookup order.
- `renderAgentContract` resolves the descriptor by `Array.prototype.find` on the `harnesses` tuple; it does not accept caller-supplied descriptor flags.
- No golden fixture is committed under `src/` or anywhere that `eslint` lints.

## Verify

- Add `src/domain/agent-contract-render.test.ts`.
- Suite name: `"src/domain/agent-contract-render"`.
- For each of the eight (harness × agent) pairs, read the golden fixture file with `node:fs` (`readFileSync`) and assert `renderAgentContract(agentContracts[agentId], harnessId)` equals the fixture string byte-for-byte (`assert.strictEqual`).
- Assert `renderAgentContract(agentContracts["re@1"], "pi")` throws `AgentContractError` with `code === "harness-cannot-deny"`.
- Assert `renderAgentContract(agentContracts["re@1"], "unknown-harness")` throws `AgentContractError` with `code === "harness-unknown"`.
- Run: `node --test src/domain/agent-contract-render.test.ts`
- `pnpm run verify` exits 0.
- Proof: `PASS EPIC-048` line `src/domain/agent-contract-render.test.ts`
