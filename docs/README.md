# Internal engine documentation

This directory contains implementation details and technical notes for engine contributors. It is **not the public manual** and is not published to GitHub Pages.

The public documentation lives in the kanthord repository and is published at [kanthord.kanthorlabs.com](https://kanthord.kanthorlabs.com). Internal brainstorming belongs to that repository's `docs/brainstorm/`, not here. Discussion material is input, not proof of implemented behavior.

## Internal notes

- [JWT acceptance checks](testing.md): repeatable contributor validation.
- [Agent instructions](../AGENTS.md): contributor conventions and shared constraints.

## Authoring policy

Keep these notes self-contained in a standalone engine checkout. Document only engine-specific details not already covered by the public documentation. Link to local source and tests for mechanisms and invariants; link to existing public pages instead of duplicating their content here. No implementation note should require the parent repository's discussion history.

Distinguish implemented behavior, approved future design, and unresolved proposals. Update relevant notes when implementation changes, and update the public documentation in the kanthord repository when users or API consumers are affected. Never promote a brainstorming proposal into a shipped guarantee without verifying it against source and tests.
