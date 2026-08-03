---
description: Drive one phase acceptance run — invoke every declared scenario id through scripts/e2e/run.mjs, record the product acceptance a machine cannot check, reference each evidence bundle, and write the verdict that closes the phase or opens a fix epic. Restates no oracle and invents no scenario. Use to close a phase, or to re-run acceptance after a fix epic lands.
argument-hint: [phase e.g. 1]  (names the run dir .data/acceptance-<tag>/ and the report)
allowed-tools: Bash, Read, Write, Edit
---

# /e2e — the phase acceptance run

Arguments: `$ARGUMENTS` — the phase number, such as `1`. The run tag comes from
`date -u +%Y%m%d%H%M%S%N`, never from you, because a one-second timestamp collides
between two parallel invocations. The tag names the run directory
`.data/acceptance-<tag>/` and the report `.agent/acceptance/<tag>/report.md`, and
nothing else. A reused tag is refused, so a rerun is a new tag.

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
2. the execution of the `deployment` scenario on the real profile, which is the
   phase exit;
3. the product acceptance a machine cannot check;
4. the verdict.

## The run

Every invocation takes the same `--tag`, so one acceptance run writes one set of
bundles. Read the phase README for the declared ids; phase 1 is `P1-E1`, `P1-E2`,
`P1-E4` and `P1-E3`.

```sh
export TAG=$(date -u +%Y%m%d%H%M%S%N)
node scripts/e2e/run.mjs P1-E1 --tag "$TAG"   # fixture baseline, local driver
node scripts/e2e/run.mjs P1-E2 --tag "$TAG"   # transport policy, local driver
node scripts/e2e/run.mjs P1-E4 --tag "$TAG"   # two namespaces, podman driver
node scripts/e2e/run.mjs P1-E3 --tag "$TAG" \
  --daemon-host "$DAEMON_HOST" --client-host "$CLIENT_HOST"
```

Order matters. The local baseline gates first, because Podman may be absent on an
environment that must still gate. The `deployment` run is last, because it is the
bundle the phase exits by pointing at.

A prerequisite is proved, never assumed: the pinned `git` binary, the pinned
Podman version with its rootless or rootful mode and architecture, both real hosts
reachable, the real repository present and the real credential valid. A missing
prerequisite makes the run report **unavailable**. It never skips and writes a
passing bundle.

Cleanup belongs to the runner. Confirm it happened; never hand-roll a teardown.
A container, a pod, a network or a volume left carrying the run id label is a
finding against the runner.

## Product acceptance, recorded separately

`docs/proposal/README.md` keeps judgment out of every scenario: a thing only a
human can judge is not a scenario. So you record it apart from the oracles, and
it never gates the run.

For phase 1 that is the first-run message, the validation finding set a human
reads while authoring a plan by hand, the re-import suggestion set, and the
`plan export` rendering. Author a plan with three faults in one document, read the
findings, fix them, then drive a re-import that needs a per-node choice. Write
what a human would think. Label the section as judgment.

## The report

Write `.agent/acceptance/<tag>/report.md`:

- the commit under test, the proposal revision, and the tag;
- each bundle by path and digest. **Reference a bundle; never merge one and never
  edit one.** A bundle is primary evidence;
- the product-acceptance section, labelled as judgment;
- the findings, grouped by root cause, one bullet each as
  `<B1/S1> - action:<YES/NO> - <name> - <description>`;
- one outcome.

## The verdict

- **passed** — every declared scenario produced a bundle, and the `deployment`
  bundle exists.
- **blocked** — the run stopped without a usable verdict. Exit non-zero. Never
  report a blocked run as a pass.
- **failed** — something was demonstrably wrong.

A blocker opens a fix epic and the phase stays open. You never fix what you find:
a fix inside an acceptance run destroys the evidence the run exists to produce.
The phase closes on a `passed` outcome tied to a proposal revision, an
implementation commit and the `deployment` bundle.

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

Remote branches a run created are named in the report and deleted by a human.
Never delete one without asking.
