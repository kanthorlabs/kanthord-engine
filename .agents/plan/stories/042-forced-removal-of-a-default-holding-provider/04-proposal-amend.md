# Story 4 — Proposal records what `force` overrides

Epic: `.agents/plan/epics/042-forced-removal-of-a-default-holding-provider.md`

## Change

**`docs/proposal/api/credential.md`**

The file currently has these lines at 42-49 (the blockers section):

```
- a non-null `set_default_at`, which puts the registration in the global chain of its kind,
- a `project_binding` row of `kind = 'provider'`,
- a `repository.credential_id` that names it, listed by repository,
- an `attempt.provider_id` that names it, listed by attempt.

The third and the fourth are not optional.
```

After the blank line that follows the fourth bullet (line 46) and before the sentence "The third and the fourth are not optional." (line 49), insert the following paragraph:

> `provider.remove` accepts `force=true` as an optional query parameter. A forced removal suppresses the first blocker only: when `set_default_at` is non-null and `force=true`, the `default-chain` entry is omitted from the blockers list. The second (`project-binding`), third (`repository`), and fourth (`attempt`) blockers remain mandatory regardless of `force`; `repository.credential_id` and `attempt.provider_id` are `NOT NULL REFERENCES provider(id)`, so overriding either would leave a registered repository pointing at a deleted credential or destroy the audit history the product exists to keep. A forced removal that is blocked by the second, third, or fourth blocker answers `409 binding-in-use` with those remaining blockers in the fixed order. A forced removal of a stamped holder that succeeds leaves that kind's default chain without a head; a human calls `provider.setDefault` to stamp a successor. `force=false` and an absent `force` parameter are equivalent; an unstamped provider's forced removal has no effect on the chain.

The four-bullet list at lines 42-46 is unchanged. The existing sentence "The third and the fourth are not optional." at line 49 and the prose that follows are unchanged.

## Constraints

- Edit only `docs/proposal/api/credential.md`. No other file.
- The inserted paragraph must state: which blocker `force` overrides, that the other three stay mandatory, the reason for the third and fourth (referential integrity), the outcome when other blockers remain with `force=true`, and that only a stamped holder's removal empties the chain.

## Verify

- `npm run verify` exits 0.
- Proof: Story 4 has no `node --test` line in the EPIC-042 Proof block. It satisfies the EPIC Goal that states `docs/proposal/api/credential.md` must record which blocker `force` overrides and why the other three are not overridable.
