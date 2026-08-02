# Open items

Reviewer: everyone. Raise anything here during your own file review.

## Answered since the brainstorm

The open question of `../brainstorm.md` is closed. A Python backend, a Vue frontend and a Flutter mobile repository are three profiles in one project, each instantiated from its own template, each declaring its own verification command. `te@1` gains Flutter testing knowledge on one repository and Vitest knowledge on another, from prose, without any change to the agent. Only the template library grows. See `phase-2/instructions-and-profiles.md`.

Bare-home seeding is closed. The bare home is created from the remote origin URL, not from a working checkout, so no original checkout has to be kept or detached. `phase-1/git-foundation.md` holds the procedure. A human checkout relates to remote origin through the standard git workflow, and never to the bare home.

## Still open

- **`pr@1` and hosted review.** They need a hosting provider client, credential handling for it, remote push and a watch loop until the pull request is mergeable. That is a phase of its own. Plan it after the MVP.

- **A second, non-coding convention.** Today one convention exists and it is simply how KanthorD behaves: a task is judged by acceptance criteria, an objective by unit tests, an initiative by end-to-end detection. No selector, no named policy, no configuration language ships. When a non-coding purpose arrives, the seam gets designed against that real case, because a link checker needs network policy and a schema validator consumes artifacts rather than a working tree. Those are execution semantics, not command names, and guessing them now would produce the wrong abstraction.

## Known trade-offs, accepted deliberately

- **The profile does not travel in a pull request.** It lives in SQLite, so a teammate cannot review a profile change in git. Export and import exist as the escape hatch if drift between teammates becomes a problem.
- **No oracle proves prose guidance is followed.** `kanthord profile verify` smoke-tests the loop and the verification command. It cannot establish that an instruction such as "never throw across a service boundary" will be respected by a probabilistic agent. The design says so rather than implying otherwise.
- **An initiative end-to-end failure means bad work already merged.** The check runs after the last objective integrates, so it detects rather than gates. `main` can stay broken until a repair objective lands, and attribution across objectives is manual. The alternative — promoting objectives to a staging ref and advancing `main` only after the whole initiative passes — was rejected because it delays every merge until the initiative finishes and has no single ref to promote when the initiative spans repositories.
- **Two independent tasks in one objective run in an arbitrary order.** They share a working tree, so they are serialized, and the tie-break is the ULID. If order matters, the author draws the edge.
