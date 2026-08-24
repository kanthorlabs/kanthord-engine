# Story 09 — The driver matches the mechanism

Epic: `.agents/plan/epics/011.1-acceptance-run-preconditions.md`
Depends on: Stories 01, 02, 03 and 04 — every flag named here must exist first.

This story ships no test. It changes exact text in `.claude/commands/e2e.md`, and a reviewer checks
each string.

## Change

All line numbers are the file as it stands today.

### 1. Lines 9-13 — the tag comes from the runner

Replace:

```markdown
Arguments: `$ARGUMENTS` — the phase number, such as `1`. The run tag comes from
`date -u +%Y%m%d%H%M%S%N`, never from you, because a one-second timestamp collides
between two parallel invocations. The tag names the run directory
`.data/acceptance-<tag>/` and the report `.agents/acceptance/<tag>/report.md`, and
nothing else. A reused tag is refused, so a rerun is a new tag.
```

with:

```markdown
Arguments: `$ARGUMENTS` — the phase number, such as `1`. The run tag comes from
`node scripts/e2e/run.mjs --mint-tag`, never from you and never from a shell
timestamp, because `date -u +%Y%m%d%H%M%S%N` is GNU coreutils and BSD `date` emits
a literal `N`. The tag names the run directory `.data/acceptance-<tag>/` and the
report `.agents/acceptance/<tag>/report.md`, and nothing else. A reused tag is
refused, so a rerun is a new tag.
```

### 2. Lines 46-53 — the run block

Replace the fenced block:

```sh
export TAG=$(date -u +%Y%m%d%H%M%S%N)
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"   # fixture baseline, local driver
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"   # transport policy, local driver
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"   # two namespaces, podman driver
node scripts/e2e/run.mjs P1-E3 --tag "$TAG" \
  --daemon-host "$DAEMON_HOST" --client-host "$CLIENT_HOST"
```

with:

```sh
export TAG=$(node scripts/e2e/run.mjs --mint-tag)
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"   # fixture baseline, local driver
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"   # transport policy, local driver
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"   # two namespaces, podman driver
node scripts/e2e/run.mjs P1-E3 --tag "$TAG" \
  --daemon-host "$DAEMON_HOST" --client-host "$CLIENT_HOST"
node scripts/e2e/run.mjs --record-verify --tag "$TAG"   # the regression suite
node scripts/e2e/run.mjs --verdict "$TAG" --scenarios-only   # the rehearsal is green
```

### 3. After line 57 — the rehearsal

Append one paragraph to the "The run" section, after "…the bundle the phase exits by pointing at.":

```markdown
`--record-verify` runs `npm run verify` and records the command, its exit status,
the commit under test and the proposal revision beside the bundles.
`--verdict <tag> --scenarios-only` checks the scenario axis alone. That is how you
report a rehearsal green, and it can never close the phase.
```

### 4. Lines 69-79 — product acceptance

Replace the heading and body:

```markdown
## Product acceptance, recorded separately

`docs/proposal/README.md` keeps judgment out of every scenario: a thing only a
human can judge is not a scenario. So you record it apart from the oracles, and
it never gates the run.

For phase 1 that is the first-run message, the validation finding set a human
reads while authoring a plan by hand, the re-import suggestion set, and the
`plan export` rendering. Author a plan with three faults in one document, read the
findings, fix them, then drive a re-import that needs a per-node choice. Write
what a human would think. Label the section as judgment.
```

with:

````markdown
## Product acceptance, recorded separately

`docs/proposal/README.md` keeps judgment out of every scenario: a thing only a
human can judge is not a scenario. So you record it apart from the oracles. It is
not an oracle and not a scenario, and it is not advisory either: it is the
acceptance axis, and the phase does not exit without it.

For phase 1 that is the first-run message, the validation finding set a human
reads while authoring a plan by hand, the re-import suggestion set, and the
`plan export` rendering. Ulrich authors a plan with three faults in one document,
reads the findings, fixes them, then drives a re-import that needs a per-node
choice. He drives the P1-E3 journey through the same CLI and the same API, on the
commit under test. One invocation signs the drive and the judgment:

```sh
node scripts/e2e/run.mjs --record-acceptance --tag "$TAG" --by Ulrich \
  --drive confirmed --judgment accepted --note-file "$NOTE"
```
````

`--drive` is `confirmed` or `not-confirmed`. `--judgment` is `accepted` or
`rejected`. A note is mandatory for `rejected` and for `not-confirmed`. The
command refuses a tag that holds no bundle, and it refuses a second write,
because a signature is not edited.

````

### 5. Lines 83-91 — the report

Replace the bullet list:

```markdown
- the commit under test, the proposal revision, and the tag;
- each bundle by path and digest. **Reference a bundle; never merge one and never
  edit one.** A bundle is primary evidence;
- the product-acceptance section, labelled as judgment;
- the findings, grouped by root cause, one bullet each as
  `<B1/S1> - action:<YES/NO> - <name> - <description>`;
- one outcome.
````

with:

```markdown
- the commit under test, the proposal revision, and the tag. The proposal revision
  is `git log -1 --format=%H -- docs/proposal`;
- each bundle by path and digest. **Reference a bundle; never merge one and never
  edit one.** A bundle is primary evidence;
- the verify record at `.data/acceptance-<tag>/verify.json`, and the acceptance
  record at `.data/acceptance-<tag>/acceptance.json`;
- the product-acceptance section, labelled as judgment;
- the `node scripts/e2e/run.mjs --verdict <tag>` command and its exit status;
- the findings, grouped by root cause, one bullet each as
  `<B1/S1> - action:<YES/NO> - <name> - <description>`;
- one outcome.
```

### 6. Lines 95-99 — the verdict on two axes

Replace:

```markdown
- **passed** — every declared scenario produced a bundle, and the `deployment`
  bundle exists.
- **blocked** — the run stopped without a usable verdict. Exit non-zero. Never
  report a blocked run as a pass.
- **failed** — something was demonstrably wrong.
```

with:

```markdown
The outcome is not asserted in prose. `node scripts/e2e/run.mjs --verdict <tag>`
checks both axes and returns the exit status.

- **passed** — `--verdict <tag>` exits zero. The scenario axis needs one bundle per
  declared scenario, all `passed`, a verify record with exit status zero, and one
  commit across every record. The acceptance axis needs a signed record on that
  same commit, reporting `drive: confirmed` and `judgment: accepted`.
- **blocked** — the run stopped without a usable verdict. Exit non-zero. Never
  report a blocked run as a pass.
- **failed** — something was demonstrably wrong.
```

### 7. Line 119 — delete

Delete the line:

```markdown
Remote branches a run created are named in the report and deleted by a human.
```

Keep line 120, "Never delete one without asking.", only if it still reads as a complete instruction
after the deletion; otherwise delete both lines. No phase-1 operation writes a ref on the remote.

## Constraints

- Only `.claude/commands/e2e.md` changes. `.agents/plan/epics/012-phase-1-acceptance-run.md` already
  carries these decisions and must not be edited.
- Keep the file's ~80-column hard wrap.
- Do not change the frontmatter at lines 1-5.
- Do not add a scenario, an oracle or a step. The two rules at lines 19-25 stand.

## Verify

- `grep -n 'TAG=$(date -u' .claude/commands/e2e.md` returns nothing. Change 1 keeps one
  `date -u +%Y%m%d%H%M%S%N` in prose, because the new text states why the shell form is wrong.
- `grep -n "Remote branches" .claude/commands/e2e.md` returns nothing.
- `grep -c "mint-tag\|record-verify\|record-acceptance\|verdict" .claude/commands/e2e.md` is at
  least 8.
- `npx prettier --check .claude/commands/e2e.md` passes.
- `npm run verify` exits 0.
- Proof: this story delivers no line of the EPIC Proof block. A reviewer checks each replaced string
  against the seven blocks above.
