# Open items

Reviewer: everyone. Raise anything here during your own file review.

## Answered since the brainstorm

The open question of `../brainstorm.md` is closed. A Python backend, a Vue frontend and a Flutter mobile repository are three profiles in one project, each instantiated from its own template, each declaring its own verification command. `te@1` gains Flutter testing knowledge on one repository and Vitest knowledge on another, from prose, without any change to the agent. Only the template library grows. See `phase-2/instructions-and-profiles.md`.

Bare-home seeding is closed. The bare home is created from the remote origin URL, not from a working checkout, so no original checkout has to be kept or detached. `phase-1/git-foundation.md` holds the procedure. A human checkout relates to remote origin through the standard git workflow, and never to the bare home.

## Answered by measurement, 2026-08-02

The fixture remote is settled, and the harness owns it: `node:http` in front of `git http-backend`, about ninety lines, with Basic authentication checked in front of the CGI. A spike drove the git client against it, and against the real `kanthord-verify` repository on GitHub with a personal access token. Both passed every row of the acceptance list in `README.md`: `HEAD` symref discovery, a seeded bare home whose only local head is the landing branch, a fetch that moves the tracking ref and leaves the landing branch untouched, a non-force push accepted, a non-fast-forward refused with the remote ref unmoved, and a branch deletion.

The same spike found a defect in the design it was testing. A read preflight cannot prove a git credential: the public `kanthord-verify` served the `git-upload-pack` advertisement to a garbage token, to a good token and to no credential at all, 28 refs every time. Only the `git-receive-pack` advertisement separated them, refusing the wrong token and answering 401 with none. `repository register` therefore proves the credential against the write advertisement, which changes nothing on the remote. See `phase-1/git-foundation.md` and `database/repository.md`.

## Answered by measurement, 2026-08-04

The git client is the `git` binary, invoked directly. `isomorphic-git` is removed.

`isomorphic-git` cannot open a local path as a remote, and phase 1 requires exactly that: an objective clone is taken from the bare home. A spike confirmed there is no way around it. `clone` refuses a bare path and a `file://` url alike, because the library's only transport is HTTP, and `objects/info/alternates` is not honoured, so materialising the objects beside the clone does not work either. The requirement and the library were incompatible, and the requirement is the product.

The replacement is the `git` binary through `node:child_process.execFile`, with no wrapper library. A wrapper was measured and rejected: it gated the environment controls this design depends on behind opt-in "unsafe" flags, and it copied the credential into its error object.

Three consequences are now product facts rather than test conveniences.

- **The `git` binary is a runtime dependency**, alongside `ssh` and `ssh-keyscan` for ssh remotes. This reverses the sentence above that said the product ships no dependency on it. The supported version range is a release artifact, verified at startup.
- **Hermeticity became an obligation.** Nothing was ambient while the client ran in process. A subprocess inherits configuration, credential helpers and a locale, so the daemon now pins the whole environment. `phase-1/git-foundation.md` holds the policy.
- **`ssh://` and `git@host:path` are supported.** They were refused because the library had no ssh transport. The binary has one, and the refusal had no product reason left, so the url policy admits ssh with a credential of the ssh kind.

The same spike settled four behaviours that the design had assumed and never checked. A fetch writes `refs/tags/*` through tag auto-follow even when the refspec names only `refs/heads/*`, so `--no-tags` is required. A local `git clone` hardlinks object files into the workspace, so `--no-hardlinks` is required or the objective and the bare home share objects on disk. `credential.helper` is multi-valued, so an empty entry must precede the daemon's own or an operator's system helper still participates. `ssh` refuses a key file that is not mode `0600` and cannot read a key from a file descriptor, so the key is a file the daemon writes, sweeps at startup, and never encrypts with a passphrase it would then have to store twice.

## Still open

- **`pr@1` and hosted review.** They need a hosting provider client, credential handling for it, remote push and a watch loop until the pull request is mergeable. That is a phase of its own. Plan it after the MVP.

- **A second, non-coding convention.** Today one convention exists and it is simply how KanthorD behaves: a task is judged by acceptance criteria, an objective by unit tests, an initiative by end-to-end detection. No selector, no named policy, no configuration language ships. When a non-coding purpose arrives, the seam gets designed against that real case, because a link checker needs network policy and a schema validator consumes artifacts rather than a working tree. Those are execution semantics, not command names, and guessing them now would produce the wrong abstraction.

## The external tool contract

The daemon runs executables it does not ship. That is a release contract, and it is recorded here because no other file owns it.

| Tool          | Needed for                         | Probe             | Absent at startup |
| ------------- | ---------------------------------- | ----------------- | ----------------- |
| `git`         | every repository operation         | version, ranged   | refuse to start   |
| `ssh`         | an ssh remote                      | version, recorded | refuse to start   |
| `ssh-keyscan` | pinning a host key at registration | presence only     | refuse to start   |

Each path comes from configuration, with a documented default, and startup resolves it and probes it. Resolution never consults an ambient `PATH`, because the same document forbids the daemon from inheriting one. A missing tool refuses the daemon rather than failing the first operation that needs it, because a daemon that starts and then cannot register a repository moves the failure away from the human who installed it.

The probes differ because the tools do. `git --version` and `ssh -V` are stable and parseable. `ssh-keyscan` has no portable version output, so it is probed for presence and executability only, and its behaviour is covered by the acceptance suite instead.

The minimum supported `git` version is a release decision, driven by the flags this design depends on rather than by a date. A version outside the range refuses startup, naming the version it found and the range it wanted. A distribution that backports a feature into an older version is not accommodated: the range is a statement about what has been tested, not a guess about what might work.

**Three executables understates the surface.** `git` is a launcher. It runs `git-remote-https`, `git-upload-pack` for a local transport, a credential helper, `ssh` for an ssh remote, and it reads a certificate bundle for TLS. Pinning `/usr/bin/git` does not pin that closure. Two rules bound it: `protocol.allow` is set so only the transports this product uses are permitted, and `GIT_EXEC_PATH` is left at the probed installation's own value rather than inherited from the environment. A local transport still executes an `upload-pack` from the source repository, which is acceptable only because the source is a bare home the daemon created.

Resolving at startup pins the path, not the file. A package upgrade replaces the binary under a running daemon, and the next invocation runs the replacement without a further check. The guarantee is therefore narrower than it looks: the version was checked once, at startup. An operator who upgrades `git` under a running daemon restarts it.

Three obligations follow for the release, and none is a code change.

- The container image installs `git` and `openssh-client` at pinned versions, and the image is what fixes the version the daemon actually runs.
- Continuous integration runs the suite against an enumerated set of `git` versions — the supported minimum, the version in the shipped image, and the newest tested — rather than against an open-ended range. The determinism rule is byte-identical output, and two `git` versions that differ in checkout behaviour would break it silently otherwise.
- The tools appear in the software bill of materials with their licences, because the product now distributes them in its image.

A host `git` is a supply-chain surface the product inherits. Its patches are the operator's responsibility on a host install, and the image's responsibility on a container install.

## Known trade-offs, accepted deliberately

- **The profile does not travel in a pull request.** It lives in SQLite, so a teammate cannot review a profile change in git. Export and import exist as the escape hatch if drift between teammates becomes a problem.
- **No oracle proves prose guidance is followed.** `kanthord profile verify` smoke-tests the loop and the verification command. It cannot establish that an instruction such as "never throw across a service boundary" will be respected by a probabilistic agent. The design says so rather than implying otherwise.
- **An initiative end-to-end failure means bad work already merged.** The check runs after the last objective integrates, so it detects rather than gates. `main` can stay broken until a repair objective lands, and attribution across objectives is manual. The alternative — promoting objectives to a staging ref and advancing `main` only after the whole initiative passes — was rejected because it delays every merge until the initiative finishes and has no single ref to promote when the initiative spans repositories.
- **Two independent tasks in one objective run in an arbitrary order.** They share a working tree, so they are serialized, and the tie-break is the ULID. If order matters, the author draws the edge.
