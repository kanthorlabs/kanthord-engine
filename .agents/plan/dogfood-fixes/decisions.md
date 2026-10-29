# Dogfood fix plan decisions

The plans cite these decisions as D1 to D4. Each decision binds every plan and every task of this set.

## D1 — Source and gaps

The design pages under `docs/brainstorm/` of the root repository at `08f65c9` are the rule (`engine/AGENTS.md:3-6`). The reference pages under `docs/reference/` follow them. A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report with the page line that proves the gap. Aelita brings it to Ulrich as one open item.

## D2 — `holder_mismatch` of a server instance

`worker.instance.list` answers `holder_mismatch: false` for an instance at the `server` or the `container` placement (`docs/brainstorm/worker-service.impl.md:544`). The service runs no agent view for such an instance. A server instance is an instance at the `server` or the `container` placement (`engine/docs/cli/worker.md:41-42`). The value of a `worker` instance does not change.

## D3 — Archive on the worker page

The Archive row action of the worker page follows the same rule as the instance page (`docs/brainstorm/architecture.impl.md:1281-1283`):

- A listing binding disables Archive and names the detach.
- A live execution with no listing binding disables nothing. The dialog holds the checkbox `Stop the live execution`, and the confirm sends `force: true`.

## D4 — Orphans

A plan removes each field, prop and helper that only fed the code that the plan removes. A plan removes no other dead code. It names other dead code in its pull request body.
