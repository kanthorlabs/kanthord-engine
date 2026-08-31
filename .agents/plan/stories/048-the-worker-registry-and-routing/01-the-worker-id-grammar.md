# Story 1 — The worker id grammar

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`

## Change

- Add `src/domain/worker-id.ts`. Export four symbols:
  - `WORKER_ID_PATTERN: RegExp` — the compiled form of `^[a-z][a-z0-9-]*@[1-9][0-9]*$`. Do not reconstruct it on each call.
  - `WorkerId` type — `Readonly<{ name: string; version: number; id: string }>`.
  - `parseWorkerId(raw: string): WorkerId` — validates `raw` against `WORKER_ID_PATTERN`, splits on `@`, parses the version with `Number(segment)`, throws `WorkerIdError` with code `worker-id-invalid` if the pattern refuses or if `version > Number.MAX_SAFE_INTEGER`. Returns `{ name, version, id: raw }` where `id` reproduces the input verbatim.
  - `WorkerIdError extends Error` with `readonly code: "worker-id-invalid"`.

## Constraints

- `src/domain/worker-id.ts` imports nothing outside `zod` or `node:` builtins. If the implementation needs no zod at all, it imports nothing.
- Do not add `workerId` to the zod schema layer in this file; a zod schema is not required by any story in this epic.
- `parseWorkerId` must check `version > Number.MAX_SAFE_INTEGER` explicitly after parsing; `Number("9007199254740993")` equals `Number.MAX_SAFE_INTEGER + 1` in IEEE 754 and must be refused.

## Verify

- Add `src/domain/worker-id.test.ts`.
- Suite name: `"src/domain/worker-id"`.
- Assert `parseWorkerId("general@1")` deep-equals `{ name: "general", version: 1, id: "general@1" }`.
- Assert `parseWorkerId("tdd@1")` deep-equals `{ name: "tdd", version: 1, id: "tdd@1" }`.
- Assert `parseWorkerId("opencode@1")` deep-equals `{ name: "opencode", version: 1, id: "opencode@1" }`.
- Assert each of the following is refused (throws `WorkerIdError` with `code === "worker-id-invalid"`): `"claude.swe@1"`, `"general"`, `"general@"`, `"general@0"`, `"General@1"`, `"general@9007199254740993"`.
- Run: `node --test src/domain/worker-id.test.ts`
- Proof: `PASS EPIC-048` line `src/domain/worker-id.test.ts`
