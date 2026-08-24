# Story 02 — Fixture repository seeding

Epic: `.agents/plan/epics/005-test-infrastructure.md`
Depends on: Story 01 (`resolveTools`).

## Change

Create `test/helpers/remote/seed.ts`. It builds a bare repository with `git`
plumbing under a pinned environment, so every object id is a literal.

Exports, exactly:

```ts
export type SeededRepository = Readonly<{
  name: string;
  path: string;
  head: string;
  refs: Readonly<Record<string, string>>;
}>;

export type SeedRoot = Readonly<{
  path: string;
  repositories: Readonly<Record<string, SeededRepository>>;
  git(repository: string, args: readonly string[]): string;
  dispose(): void;
}>;

export const fixtureObjectIds: Readonly<Record<string, string>>;
export const pinnedGitEnvironment: Readonly<Record<string, string>>;
export const pinnedGitConfigArguments: readonly string[];

export function seedRepositories(tools: Tools): SeedRoot;
```

`pinnedGitEnvironment` is exactly this record and nothing more:

```ts
export const pinnedGitEnvironment = {
  PATH: "",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Kanthord Fixture",
  GIT_AUTHOR_EMAIL: "fixture@kanthord.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "Kanthord Fixture",
  GIT_COMMITTER_EMAIL: "fixture@kanthord.invalid",
  GIT_COMMITTER_DATE: "1700000000 +0000",
} as const;
```

`PATH` is set to `tools.execPath` at call time, overriding the `""` above.
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_COUNT`, `GIT_DEFAULT_HASH` and every
`GIT_TRACE*` are absent by construction, because the record is the whole
environment and nothing is inherited.

`pinnedGitConfigArguments` is exactly:

```ts
export const pinnedGitConfigArguments = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fileMode=true",
  "-c",
  "core.symlinks=false",
  "-c",
  "core.ignoreCase=false",
  "-c",
  "core.precomposeUnicode=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgSign=false",
] as const;
```

`seedRepositories(tools)`:

1. `fs.mkdtempSync(join(tmpdir(), "kanthord-remote-"))` is the root.
2. Build one repository, `"fixture.git"`, at `<root>/fixture.git`:
   - `git init --bare --quiet --template= --initial-branch=main --object-format=sha1 <path>`.
     `--template=` is required, so no operator template hook is copied in.
     `--object-format=sha1` is **required**: every literal below is a SHA-1 id, and
     a `git` whose default object format is SHA-256 — set at build time or through
     `GIT_DEFAULT_HASH` — would invalidate all seven at once. The flag makes the
     hash a property of the fixture rather than of the installation.
   - `hash-object -w --stdin` with the exact bytes `"kanthord fixture\n"`.
   - `mktree` from the exact line
     `` `100644 blob ${blob1}\tREADME.md\n` `` — a tab before the name, one
     trailing newline.
   - `commit-tree <tree1> -m "fixture: initial"`.
   - `hash-object -w --stdin` with `"kanthord fixture second\n"`.
   - `mktree` from `` `100644 blob ${blob2}\tREADME.md\n` ``.
   - `commit-tree <tree2> -p <commit1> -m "fixture: second"`.
   - `update-ref refs/heads/main <commit2>`.
   - `symbolic-ref HEAD refs/heads/main`.
   - `mktag` from stdin, exactly these bytes:
     ```
     object <commit2>
     type commit
     tag v1
     tagger Kanthord Fixture <fixture@kanthord.invalid> 1700000000 +0000

     fixture tag
     ```
     then `update-ref refs/tags/v1 <tagObject>`.
   - `config http.receivepack true` and `config http.uploadpack true`, so
     `git-http-backend` serves both advertisements.
3. Every invocation is
   `execFileSync(tools.paths.git, [...pinnedGitConfigArguments, "-C", repositoryPath, ...args], { env: { ...pinnedGitEnvironment, PATH: tools.execPath }, encoding: "utf8", input, timeout: toolTimeoutMilliseconds, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 })`,
   and the returned string is `.trim()`ed. `git init` takes the path as an
   argument rather than through `-C`. The `timeout` triple is mandatory on every
   external command in this epic — see Story 01.
4. `git(repository, args)` on the handle runs the same pinned invocation against a
   named seeded repository and returns trimmed stdout. This is how a later epic
   advances the fixture remote by writing to the bare repository directly, per
   `docs/proposal/README.md:90`.
5. `dispose()` is `fs.rmSync(root, { recursive: true, force: true })`, idempotent,
   matching `test/helpers/home.ts:52-54`.

`fixtureObjectIds` holds these **measured** literals. They are asserted, not
recomputed:

```ts
export const fixtureObjectIds = {
  blob1: "6c2f06c3353a5ee6d33ce8aaf5126add4fbcdb77",
  tree1: "7849fc5f2a2f694310ce3ebfcf77551c8ff814cb",
  commit1: "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca",
  blob2: "b388162b9d33548ecc42b01fcff0c25c74f304b4",
  tree2: "b20c34a30ebfdac99ed382aa5cefdf906bb94aa1",
  commit2: "251c92d5a215053aea80432f179653f99072835d",
  tagV1: "3e5b142033c55afaa59871afbe0a5f1e3947743f",
} as const;
```

`repositories["fixture.git"]` carries `head: "251c92d5a215053aea80432f179653f99072835d"`
and `refs` exactly:

```ts
{
  "refs/heads/main": "251c92d5a215053aea80432f179653f99072835d",
  "refs/tags/v1": "3e5b142033c55afaa59871afbe0a5f1e3947743f",
}
```

## Constraints

- One repository, `fixture.git`, and it carries the tag. The `--no-tags`
  assertions of this epic and of EPIC 006 need a tagged repository, and a second
  untagged repository would be an unused fixture.
- No `git add`, no `git commit`, no working tree. Plumbing only — `hash-object`,
  `mktree`, `commit-tree`, `mktag`, `update-ref`, `symbolic-ref`. A porcelain
  commit reads an index and a working tree, and neither is pinned.
- `refs` is a plain sorted record built from `for-each-ref`, never from a live
  `git` call at read time.
- No network. `git init` with `--template=` and nothing else.

## Verify

`node --test test/helpers/remote/seed.test.ts`, asserting exactly:

- `seedRepositories(resolveTools())` produces a `fixture.git` whose
  `rev-parse refs/heads/main` equals `fixtureObjectIds.commit2` as an exact string
  literal.
- Each of the seven `fixtureObjectIds` values is the id `git` reports:
  `cat-file -t <blob1>` is `blob`, `<tree1>` is `tree`, `<commit1>` and
  `<commit2>` are `commit`, `<tagV1>` is `tag`.
- `cat-file blob <blob1>` returns exactly `"kanthord fixture\n"`, byte-compared
  with `assert.equal` on a `utf8` read.
- `rev-parse <commit2>^` equals `fixtureObjectIds.commit1`, pinning the parent
  edge.
- `symbolic-ref HEAD` returns `"refs/heads/main"`.
- `for-each-ref --format='%(refname)'` returns exactly
  `["refs/heads/main", "refs/tags/v1"]`, in that order.
- `repositories["fixture.git"].refs` deep-equals the two-entry record above.
- **The determinism assertion**: call `seedRepositories` a second time in the same
  test, receiving a different `path`, and assert the second root's
  `repositories["fixture.git"].refs` deep-equals the first's, and that
  `first.path !== second.path`. Dispose both.
- `pinnedGitEnvironment` has no `GIT_DIR`, no `GIT_WORK_TREE`, no
  `GIT_CONFIG_COUNT`, no `GIT_DEFAULT_HASH`, and no key matching `/^GIT_TRACE/`,
  asserted over `Object.keys`.
- **The object format is sha1 regardless of the installation default**: run the
  seeding with `GIT_DEFAULT_HASH: "sha256"` injected into the environment and
  assert the ids are still the seven literals. This proves `--object-format=sha1`
  is load-bearing. Skip this assertion only if the local `git` rejects
  `--object-format=sha256` outright, in which case assert that rejection instead
  so the test still fails when the flag is dropped.
- Every seeded id matches `/^[0-9a-f]{40}$/`, so a SHA-256 repository fails loudly
  rather than comparing unequal strings.
- **The hostile-`HOME` assertion**: write a `.gitconfig` carrying
  `[core]\n\tautocrlf = true\n` into a `mkdtemp` directory, and run the pinned
  invocation with that directory as `HOME`. `config --get core.autocrlf` exits
  non-zero and yields no value, so the operator setting does not take effect. The
  same call **without** `GIT_CONFIG_GLOBAL=/dev/null` reports `true`, which is
  what proves the pin is load-bearing rather than vacuous.
- `dispose()` twice does not throw, and `fs.existsSync(root.path)` is false after
  the first.

`npm run verify` exits 0.

Proof: prerequisite of `PASS EPIC-005`, and it delivers the coverage line "The
seeded object ids are asserted as exact literals, and they are identical on a
second run in a different temporary directory."

## Measured facts

- The seven literals above were produced twice from two different temporary
  directories on `git version 2.50.1 (Apple Git-155)` and were identical. Object
  hashing does not vary by `git` version, so the floor of Story 01 does not move
  them.
- `git --exec-path` on this machine is
  `/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core`, so `PATH`
  must be `tools.execPath` and not `/usr/bin`.
