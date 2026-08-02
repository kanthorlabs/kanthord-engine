# After the MVP

Reviewer: delivery lead. Each item below is deferred because it serves neither a named phase blocker nor daily use by one human on one repository.

Deferring an item does not delete its design. Where a file already specifies one, it says so in a `Deferred` section, and the entity model in `phase-1/domain.md` already holds the shape.

- **`tdd@1`**, composing the `te@1` and `swe@1` agents with `re@1`. `re@1` itself ships in the MVP, because it is the task gate for every worker kind. See `phase-2/agents-and-workers.md`.
- **`git@1` and the undo node.** A declared git operation that needs no model. The undo node is only useful once enough work merged to need reversing.
- **Multi-repository projects.** A project binds several repositories, and an objective names the one it works in.
- **Initiative end-to-end detection.** The project-level verifier binding, the repository-to-commit manifest, the run after the last objective integrates, and the `e2e-failed` block. An MVP initiative always records `not-applicable`. See `phase-2/gates-and-approval.md`.
- **Concurrent objectives.** The lease protocol ships in the MVP for correctness. Running two objectives at once is advanced usage.
- **Event stream over HTTP** for status watching.
- **The ordered provider chain**, failover across registrations, and wrap-around selection. It also needs a `position` column and a model override on the binding rows, which the MVP shape does not carry. See `phase-2/providers-and-credentials.md`.
- **Master key rotation.**
- **`kanthord profile verify` gate C**, the hermetic canary through a real agent. Gates A and B ship in the MVP.
- **Onboarding template detection**, and the template library beyond the first template.
- **`pr@1` and hosted review.** The objective clone creates a branch, pushes it to remote origin with an explicit URL, opens a pull request, and watches only for the merged state. CI gates and approval policy belong to the hosting side. This grants the objective-side process network and credential access, which is a capability boundary to design then, not to assume now.
- **Token accounting and spend reporting.**
