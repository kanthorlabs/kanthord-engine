# Story 5 — The proposal states the rule

Epic: `.agents/plan/epics/037-component-publication-catalogue-or-reachable.md`
Depends on: Story 4.

Lane: software-engineer only. `scripts/lane-check.sh:99-101` grants
`docs/proposal/*` to that lane and denies it to the test-engineer. This story
writes no code and no test.

`docs/proposal/api/README.md` is the source of truth for behaviour, so the rule
the builder now carries has to appear there.

## Change

Edit `docs/proposal/api/README.md`. Replace lines 15 to 21. Line 13 is the
heading `### OpenAPI documents are generated, and they are not committed` and it
stays unchanged. Lines 14, 16, 18 and 20 are blank separators.

Keep line 15 and line 19 **verbatim**. Line 15 carries the self-contained rule
and the external-`$ref` refusal. Line 19 carries the not-committed reason. Keep
line 21 verbatim as the last paragraph of the section.

Insert three new paragraphs. The first replaces line 17. The second and third go
after line 19 and before line 21.

### Replace line 17

Line 17 today:

> The publication also writes one self-contained document under `features/<namespace>.yaml` for each operation namespace. Each feature document carries its own schemas and references, so a UI client can generate one feature without bundling other files. The master document remains the complete API contract.

Becomes:

> The publication also writes one self-contained document under `features/<namespace>.yaml` for each operation namespace. Each feature document carries its own schemas and references, so a UI client can generate one feature without bundling other files. The master document remains the complete API contract.
>
> Every emitted document holds the transitive closure of its own references, and nothing else. The closure seeds from every root key except `components`, follows a `$ref` that starts with `#/components/schemas/`, follows a nested `$ref` inside a schema body, and follows every value of a `discriminator.mapping` object. A component that no root key reaches is not emitted. A slice therefore drops `#/components/schemas/Error` when every operation of that slice declares its own error envelope.

### Insert after line 19

> The root extension `x-kanthord-event-payloads` carries the event payload catalogue. It maps each event type to the component of that type, as one internal `$ref` per entry, and its keys sort bytewise as `components.schemas` does. The extension makes all 37 payload schemas reachable by construction, so the closure rule keeps them.
>
> ```yaml
> x-kanthord-event-payloads:
>   node.created:
>     $ref: "#/components/schemas/node.created"
> ```
>
> A document carries the extension when it holds the operation `event.list`, which is the only route that delivers an event payload. The master carries it and `features/event.yaml` carries it. No other slice carries it, and no other slice holds a payload schema.
>
> `event.list` returns an **unconstrained** payload. The response schema declares the payload as unknown, so the catalogue is advisory to a consumer: it names the shape a consumer can expect per event type, and no emitted document guarantees that shape. A consumer generates its event handlers from the 37 named schemas at its own risk until append-time validation lands.
>
> OpenAPI 3.0.3 is a decision, not an accident. Every contract test pins the `openapi-3.0` mapping of `z.toJSONSchema`. A move to 3.1 changes `nullable`, `exclusiveMinimum` and `examples`, so it costs a fresh parity pass. The version, the artifact topology and the self-contained rule are three independent decisions.

Use `node.created` in the YAML example. It is a real member of `eventTypes` at
`src/domain/event-type.ts:9`. Do not use `node.state.changed`, which the EPIC
uses as an illustration but which is not a declared event type.

### Formatting

```bash
npx prettier --write docs/proposal/api/README.md
```

## Constraints

- **No code.** This story edits one Markdown file and nothing else.
- **Keep the refusal.** The sentence in line 15 that refuses an external `$ref`
  split stays word for word. EPIC 039 amends it later; this story does not.
- **Keep the not-committed rule** in line 19 word for word.
- **Do not touch lines 1-12, or line 23 onward.** The release-gate section at
  line 23 and the reviewer table at line 39 stay unchanged.
- **State the rule, not the search for it.** Record the decision and the
  constraint it imposes. Write no alternative, no rejection and no measurement.
- **Do not edit `AGENTS.md`.** `scripts/lane-check.sh:43` locks it. Open item S1
  of the EPIC carries that edit to Ulrich.

## Verify

```bash
npm run verify
git status --porcelain
```

- `npm run verify` exits 0. `format` leaves the file unchanged after the prettier
  run above, so the document is canonical.
- `git status --porcelain` lists exactly one path,
  `docs/proposal/api/README.md`. The command must not be filtered by that path:
  `git diff --stat docs/proposal/api/README.md` only reports on the path it is
  given, so it can never show that the path is the only one changed.
- Read the section back and confirm all five statements are present: the closure
  rule, the `x-kanthord-event-payloads` extension and its shape, the statement
  that the extension makes the catalogue reachable in the master and in the
  `event` slice only, the statement that `event.list` returns an unconstrained
  payload and that the catalogue is advisory, and the statement that 3.0.3 is a
  decision.

Proof: this story delivers no line of the Proof command, because it changes no
code. It delivers the EPIC Goal clause "It amends `docs/proposal/api/README.md:13-21`"
and it satisfies `AGENTS.md`, which makes `docs/proposal/` the source of truth for
behaviour.
