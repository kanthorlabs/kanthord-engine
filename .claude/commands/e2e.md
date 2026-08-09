---
description: Drive one phase acceptance run — invoke every declared scenario id through scripts/e2e/run.mjs, record the product acceptance a machine cannot check, reference each evidence bundle, and write the verdict that closes the phase or opens a fix epic. Restates no oracle and invents no scenario. Use to close a phase, or to re-run acceptance after a fix epic lands.
argument-hint: [phase e.g. 1]  (names the run dir .data/acceptance-<tag>/ and the report)
allowed-tools: Bash, Read, Write, Edit
---

# /e2e — the phase acceptance run

Arguments: `$ARGUMENTS` — the phase number, such as `1`. The run tag comes from
`node scripts/e2e/run.mjs --mint-tag`, never from you and never from a shell
timestamp, because `date -u +%Y%m%d%H%M%S%N` is GNU coreutils and BSD `date` emits
a literal `N`. The tag names the run directory `.data/acceptance-<tag>/` and the
report `.agent/acceptance/<tag>/report.md`, and nothing else. A reused tag is
refused, so a rerun is a new tag.

This command drives EPIC 012. It executes scenarios; it never defines one.

## Two rules that decide every judgment call

- **You restate no oracle.** `docs/proposal/<phase>/README.md` declares each
  scenario id, mode, driver, profile and oracle. `scripts/e2e/run.mjs` implements
  them. You invoke an id and you read the result. When you want to assert
  something the oracle does not, that is a finding about the oracle, not a check
  you add here.
- **You invent no scenario.** A gap you find becomes a proposal amendment, then a
  story in the scenario epic. It never becomes a step in this run.

Never re-derive state with ad-hoc `list … --json | node -e …`. Every scenario
already prints and bundles what it observed.

## What you own

The four things no scenario owns:

1. the run frame — one tag, one directory, one report;
2. the execution of the real-profile scenario, which is the phase exit;
3. the product acceptance a machine cannot check;
4. the verdict.

## The run

Every invocation takes the same `--tag`, so one acceptance run writes one set of
bundles. Read the phase README for the declared ids; phase 1 is `P1-E1`, `P1-E2`,
`P1-E4` and `P1-E5`.

```sh
export TAG=$(node scripts/e2e/run.mjs --mint-tag)
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"   # fixture baseline, local driver
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"   # transport policy, local driver
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"   # two namespaces, podman driver
node scripts/e2e/run.mjs P1-E5 --tag "$TAG"   # real repository, local driver
node scripts/e2e/run.mjs --record-verify --tag "$TAG"   # the regression suite
node scripts/e2e/run.mjs --verdict "$TAG" --scenarios-only   # the rehearsal is green
```

Order matters. The local baseline gates first, because Podman may be absent on an
environment that must still gate. The real-profile run is last, because it is the
bundle the phase exits by pointing at.

`--record-verify` runs `npm run verify` and records the command, its exit status,
the commit under test and the proposal revision beside the bundles.
`--verdict <tag> --scenarios-only` checks the scenario axis alone. That is how you
report a rehearsal green, and it can never close the phase.

A prerequisite is proved, never assumed: the pinned `git` binary, the pinned
Podman version with its rootless or rootful mode and architecture, a complete
`.env.e2e`, and the real repository and the real credential valid. A missing
prerequisite makes the run report **unavailable**. It never skips and writes a
passing bundle.

Cleanup belongs to the runner. Confirm it happened; never hand-roll a teardown.
A container, a pod, a network or a volume left carrying the run id label is a
finding against the runner.

## Product acceptance, recorded separately

`docs/proposal/README.md` keeps judgment out of every scenario: a thing only a
human can judge is not a scenario. So you record it apart from the oracles. It is
not an oracle and not a scenario, and it is not advisory either: it is the
acceptance axis, and the phase does not exit without it.

For phase 1 that is the first-run message, the validation finding set a human
reads while authoring a plan by hand, the re-import suggestion set, and the
`plan export` rendering. Ulrich authors a plan with three faults in one document,
reads the findings, fixes them, then drives a re-import that needs a per-node
choice. He drives the P1-E5 journey through the same CLI and the same API, on the
commit under test. One invocation signs the drive and the judgment:

```sh
node scripts/e2e/run.mjs --record-acceptance --tag "$TAG" --by Ulrich \
  --drive confirmed --judgment accepted --note-file "$NOTE"
```

`--drive` is `confirmed` or `not-confirmed`. `--judgment` is `accepted` or
`rejected`. A note is mandatory for `rejected` and for `not-confirmed`. The
command refuses a tag that holds no bundle, and it refuses a second write,
because a signature is not edited.

## The report

Write `.agent/acceptance/<tag>/report.md`:

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

## The verdict

The outcome is not asserted in prose. `node scripts/e2e/run.mjs --verdict <tag>`
checks both axes and returns the exit status.

- **passed** — `--verdict <tag>` exits zero. The scenario axis needs one bundle per
  declared scenario, all `passed`, a verify record with exit status zero, and one
  commit across every record. The acceptance axis needs a signed record on that
  same commit, reporting `drive: confirmed` and `judgment: accepted`.
- **blocked** — the run stopped without a usable verdict. Exit non-zero. Never
  report a blocked run as a pass.
- **failed** — something was demonstrably wrong.

A blocker opens a fix epic and the phase stays open. You never fix what you find:
a fix inside an acceptance run destroys the evidence the run exists to produce.
The phase closes on a `passed` outcome tied to a proposal revision, an
implementation commit and the real-profile bundle.

The report is evidence, not a plan file. That is why it lives under
`.agent/acceptance/` and not under `.agent/plan/epics/`.

## Secrets

Never pass a secret as a command argument — argv is visible in `ps`. A token
reaches a container as a mounted file with restrictive permissions, never an
environment variable and never an argument, because `podman inspect` and a printed
command each disclose the other two. Assert redaction over the bearer header, the
fixture Basic-auth header, the config file, the printed commands, the daemon logs,
the inspect output and the failure diagnostics — on a deliberately failing run as
well as a passing one.
