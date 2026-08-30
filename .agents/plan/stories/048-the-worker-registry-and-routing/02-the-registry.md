# Story 2 — The registry

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 1

## Change

- Add `src/domain/worker-registry.ts`. Export four symbols:
  - `Composition` type — `"single" | "composed" | "self-managed"`.
  - `compositions: readonly ["single", "composed", "self-managed"]` — a `const` tuple.
  - `WorkerEntry` type — `Readonly<{ worker: string; driver: "internal" | "external"; agents: readonly string[]; claims: readonly string[]; deliverables: readonly string[]; harness: string | null; metadata: { composition: Composition } }>`.
  - `workerRegistry: readonly [WorkerEntry, WorkerEntry]` — a `const` tuple holding exactly these two entries in this order:

    Entry 0 — `claude@1`:

    ```
    worker: "claude@1"
    driver: "external"
    agents: []
    claims: ["objective", "task"]
    deliverables: ["test", "implementation", "review"]
    harness: "claude-code"
    metadata: { composition: "self-managed" }
    ```

    Entry 1 — `opencode@1`:

    ```
    worker: "opencode@1"
    driver: "external"
    agents: []
    claims: ["objective", "task"]
    deliverables: ["test", "implementation", "review"]
    harness: "opencode"
    metadata: { composition: "self-managed" }
    ```

- The registry data is a `const` object literal, not a constructor call. `src/domain/worker-registry.ts` imports nothing from `./worker-id.ts`.

## Constraints

- The `claims` and `deliverables` arrays match the Decisions table verbatim: `claims: ["objective", "task"]`, `deliverables: ["test", "implementation", "review"]` for both entries.
- `agents` is `[]` (empty) for both entries.
- `harness` is non-null for both entries: `"claude-code"` and `"opencode"`.
- No entry declares `"expansion"` in `deliverables` and no entry includes `"initiative"` in `claims`.
- `compositions` is declared in this file, not imported from elsewhere.

## Verify

- Add `src/domain/worker-registry.test.ts`.
- Suite name: `"src/domain/worker-registry"`.
- Assert `workerRegistry` deep-equals the exact literal:
  ```
  [
    { worker: "claude@1", driver: "external", agents: [], claims: ["objective", "task"], deliverables: ["test", "implementation", "review"], harness: "claude-code", metadata: { composition: "self-managed" } },
    { worker: "opencode@1", driver: "external", agents: [], claims: ["objective", "task"], deliverables: ["test", "implementation", "review"], harness: "opencode", metadata: { composition: "self-managed" } },
  ]
  ```
- Assert both entries carry `driver: "external"`, `agents` that deep-equals `[]`, a non-null `harness`, and `metadata.composition === "self-managed"`, each asserted per entry.
- Assert `workerRegistry.every((e) => !e.deliverables.includes("expansion"))` is true.
- Assert `workerRegistry.every((e) => !e.claims.includes("initiative"))` is true.
- Assert `compositions` deep-equals `["single", "composed", "self-managed"]`.
- Import `parseWorkerId` from `./worker-id.ts`. Assert `parseWorkerId(workerRegistry[0].worker)` does not throw and its `id` equals `"claude@1"`. Assert `parseWorkerId(workerRegistry[1].worker)` does not throw and its `id` equals `"opencode@1"`.
- Assert `workerRegistry.every((e) => e.agents.length === 0)` is true (no registry entry references an agent id).
- Run: `node --test src/domain/worker-registry.test.ts`
- Proof: `PASS EPIC-048` line `src/domain/worker-registry.test.ts`
