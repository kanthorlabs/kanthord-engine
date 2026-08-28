# Story 6 — proposal records the mechanism and the shape

Epic: `.agents/plan/epics/043-repository-inspect-reports-write-access.md`

## Change

### `docs/proposal/api/repository.md`

Locate the subsection whose heading is **"The credential verdict here is a read verdict"** (currently around line 49). Replace the entire subsection — from the heading through and including the sentence that reads "Registration is where the credential is proved." — with the following text verbatim:

````markdown
### The credential verdict reports read and write access independently

`inspect` reports whether the credential reached the remote for a **read** and,
when `requiredAccess: "write"` is requested, for a **write-advertisement** as
well. The response carries two members:

```json
"access": {
  "read":  { "allowed": true,  "refusal": null },
  "write": { "allowed": false, "refusal": "auth-failed" }
}
```
````

`access.read` mirrors `credential` exactly. `access.write` is `null` when
`requiredAccess` is absent or `"read"`, and a full verdict when `"write"` was
requested.

**How the write-advertisement works.** The git service creates a temporary bare
repository, fetches the remote's default branch, calls
`git push --dry-run` at the publish ref of that branch with the fetched object
id, and removes the temporary repository before returning. `inspect` still seeds
no home, and nothing written during the probe survives the call. Credential
files (helper scripts and SSH keys) are written inside the same temporary
directory and are removed with it. The probe's cost is one fetch plus one
dry-run push against the remote.

**A read failure short-circuits the probe.** A credential that cannot reach the
remote via `git ls-remote` cannot fetch the object the probe needs. When
`remoteInfo` fails, `access.write` carries the same refusal as `access.read`
without a network call to the write side.

**A remote with no default branch yields** `access.write:
{ allowed: false, refusal: "empty-remote" }` and no fetch is attempted.

**`reachable: true` is not a statement about push permission.** A public
repository serves `git-upload-pack` to anyone, so a garbage token reads the ref
list exactly like a good one. Use `requiredAccess: "write"` to obtain a
write-advertisement verdict before registration.

**The write-advertisement verdict proves only write-advertisement access.**
Branch protection, a required status check, a signature rule or a server hook
can still reject a later publish to the same ref. The verdict says the credential
authenticates and may push to the repository; it never says a publish will be
accepted. See the caveat at the end of this section.

```

After that replacement, find the sentence that reads:
"A successful inspect authorizes nothing."

Append a sentence immediately after it (still in the same paragraph):
"A write-advertisement verdict on `inspect` is evidence that push access exists at the time of the call; it is not a guarantee that a later `repository.register` or publish will succeed."

**No other edits to `docs/proposal/api/repository.md`.** The `repository.register` sections, the explicit seeding sequence, and the credential section are unchanged.

## Constraints

- The heading changes from "The credential verdict here is a read verdict" to "The credential verdict reports read and write access independently".
- The phrase "write-advertisement verdict" is used throughout instead of "proof of push permission" or "push capability".
- The fenced JSON block uses triple-backtick `json`.
- No production `.ts` or `.js` file is changed in this story.

## Verify

```

npm run verify

```

`npm run verify` exits 0. There is no automated test for the proposal document content; the gate is the full verify run which validates the contract, registry, and all named test files.

Proof: This story supports the overall `PASS EPIC-043` by ensuring the proposal is coherent and does not contradict the implementation. It delivers no dedicated Proof line.
```
