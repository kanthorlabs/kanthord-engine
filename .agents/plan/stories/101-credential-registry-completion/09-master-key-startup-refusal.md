# Story 9 — Master key startup refusal

Epic: `.agents/plan/epics/101-credential-registry-completion.md`
Depends on: EPIC 100.

## Change

- In `src/services/config/convict.ts:59-86`, replace `readTokenFile` with private `openRestrictedSecretFile(filePath, settingName)`.
- Return a handle with numeric mode, `read(): string` and idempotent `close(): void`; open once with `fs.openSync`, fstat that descriptor and read through that descriptor.
- If fstat fails after open, close the descriptor before error conversion. Close every returned handle exactly once.
- Convert ENOENT from open, fstat or read to `ConfigError("config-invalid", "<settingName> not found: <path>")`.
- Convert every other open, fstat or read error to `ConfigError("config-refused", "<settingName> refused at <path>: <OS code>")`.
- In `ConvictConfig.load` at `src/services/config/convict.ts:325-381`, open configured master-key and token files inside one outer try/finally.
- Open `masterKeyFile` first and `http.tokenFile` second; when both opens fail, report the master-key failure.
- Pass fstat modes to `assertStartable` before any handle read. After it returns, read token and master-key content through their handles and retain existing newline and base64 transformations.
- Close every opened handle in the outer finally. If work already threw, preserve that error over a close error.

## Constraints

- Preserve absent-key, both-sources and 0600 refusal messages in `src/services/config/refusals.ts`.
- A non-0600 directory must fail the mode check before read. A 0600 directory must reach read and become config-refused EISDIR.
- A self-referential symlink must become config-refused ELOOP from open.
- Never include secret content or decoded key bytes in an error.

## Verify

- Extend `src/services/config/convict.test.ts:839-893` to retain the real 0644 refusal and 0600 32-byte success.
- Add a private temporary directory chmodded to 0600 as masterKeyFile; assert ConfigError, config-refused, configured path and EISDIR, and assert the error is not a raw system error.
- Add a self-referential symlink as masterKeyFile; assert ConfigError, config-refused, configured path and ELOOP.
- Add a dual-failure test with self-referential symlinks for both masterKeyFile and http.tokenFile; assert the exact master-key ELOOP message and no token-file path.
- Keep `src/services/config/refusals.test.ts:75-133` green for missing sources, both sources and literal 0644 mode.
- Add `src/services/config/startup.test.ts` using `createTemporaryHome`, `reservePort` and `launchDaemon`; remove both key fields from config.
- Assert exit code 1, empty stdout, stderr starts with `kanthord: config-refused:`, no `daemon.lock.identity`, and fetch to the reserved port rejects with ECONNREFUSED.
- Run `node --test src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts`; it exits 0.
- Run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 42-45, plus Hermetic coverage lines 69-73.
